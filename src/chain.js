import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  hexToBigInt,
  isAddress,
  keccak256,
  parseUnits,
  stringToHex,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ATLANTIC_CHAIN_ID, withAtlanticMcp } from "./mcp-runtime.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sagaKey = (id) => keccak256(stringToHex(id));

export function assertPrivateKey(value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value || "")) throw new Error("Server signer is not configured");
  return value;
}

export function parseAmount(value, decimals, max = "10") {
  if (!/^\d+(?:\.\d+)?$/.test(value || "")) throw new Error("Amount must be a positive decimal string");
  const amount = parseUnits(value, decimals);
  if (amount <= 0n) throw new Error("Amount must be greater than zero");
  if (amount > parseUnits(max, decimals)) throw new Error(`Amount exceeds the demo maximum of ${max}`);
  return amount;
}

function asHex(value) {
  return toHex(BigInt(value));
}

export class AtlanticChain {
  constructor({ rpcUrl, privateKey }) {
    this.rpcUrl = rpcUrl;
    this.account = privateKeyToAccount(assertPrivateKey(privateKey));
  }

  async session(operation) {
    return withAtlanticMcp(this.rpcUrl, async (mcp) => {
      const info = await mcp.call("get_chain_info");
      if (info.chainId !== ATLANTIC_CHAIN_ID || !info.chainIdMatches) throw new Error(`Wrong chain: ${info.chainId}`);
      return operation(mcp, info);
    });
  }

  async read(mcp, address, abi, functionName, args = [], block = "latest") {
    const data = encodeFunctionData({ abi, functionName, args });
    const { result } = await mcp.call("eth_call", { transaction: { to: getAddress(address), data }, block });
    return decodeFunctionResult({ abi, functionName, data: result });
  }

  async snapshot(mcp, contracts, sagaId) {
    const owner = this.account.address;
    const decimals = Number(await this.read(mcp, contracts.token, contracts.tokenAbi, "decimals"));
    const symbol = await this.read(mcp, contracts.token, contracts.tokenAbi, "symbol");
    const balance = await this.read(mcp, contracts.token, contracts.tokenAbi, "balanceOf", [owner]);
    const allowance = await this.read(mcp, contracts.token, contracts.tokenAbi, "allowance", [owner, contracts.escrow]);
    const vaultCredit = await this.read(mcp, contracts.vault, contracts.vaultAbi, "creditOf", [owner]);
    const entry = sagaId ? await this.read(mcp, contracts.escrow, contracts.escrowAbi, "entries", [sagaKey(sagaId)]) : ["0x0000000000000000000000000000000000000000", 0n, 0];
    return {
      owner,
      token: contracts.token,
      symbol,
      decimals,
      ownerBalanceRaw: balance.toString(),
      ownerBalance: formatUnits(balance, decimals),
      allowanceRaw: allowance.toString(),
      allowance: formatUnits(allowance, decimals),
      vaultCreditRaw: vaultCredit.toString(),
      vaultCredit: formatUnits(vaultCredit, decimals),
      escrow: { owner: entry[0], amountRaw: entry[1].toString(), amount: formatUnits(entry[1], decimals), status: Number(entry[2]) },
    };
  }

  async preflight(mcp, { to, data, value = 0n }) {
    return mcp.call("estimate_gas", { transaction: { from: this.account.address, to, data, value: asHex(value) } });
  }

  async send(mcp, { to, data = "0x", value = 0n, onHash, receiptPolls = 24 }) {
    const [nonceInfo, gasInfo] = await Promise.all([
      mcp.call("get_transaction_count", { address: this.account.address, block: "pending" }),
      mcp.call("get_gas_price"),
    ]);
    const nonce = BigInt(nonceInfo.nonce);
    const gasPrice = BigInt(gasInfo.gasPriceWei);
    const estimate = await mcp.call("estimate_gas", {
      transaction: { from: this.account.address, to, data, value: asHex(value), gasPrice: asHex(gasPrice), nonce: asHex(nonce) },
    });
    const raw = await this.account.signTransaction({
      chainId: ATLANTIC_CHAIN_ID,
      type: "legacy",
      nonce,
      to,
      data,
      value,
      gas: (BigInt(estimate.gas) * 120n) / 100n,
      gasPrice,
    });
    const expectedHash = keccak256(raw);
    await onHash?.(expectedHash, {
      nonce: nonce.toString(),
      gasEstimate: estimate.gas,
      gasLimit: ((BigInt(estimate.gas) * 120n) / 100n).toString(),
      gasPriceWei: gasPrice.toString(),
      maximumCostWei: (((BigInt(estimate.gas) * 120n) / 100n) * gasPrice + value).toString(),
      rawPersistedBeforeBroadcast: true,
    });
    try {
      const submitted = await mcp.call("send_raw_transaction", { rawTransaction: raw });
      if (submitted.txHash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("RPC returned a different transaction hash");
    } catch (error) {
      const [known, receipt, pendingNonce] = await Promise.all([
        mcp.call("get_transaction", { hash: expectedHash }).catch(() => null),
        mcp.call("get_transaction_receipt", { hash: expectedHash }).catch(() => null),
        mcp.call("get_transaction_count", { address: this.account.address, block: "pending" }).catch(() => null),
      ]);
      if (!known && !receipt) {
        error.reconciliation = { expectedHash, nonce: nonce.toString(), pendingNonce: pendingNonce?.nonce ?? null };
        throw error;
      }
    }
    for (let attempt = 1; attempt <= receiptPolls; attempt += 1) {
      const receipt = await mcp.call("get_transaction_receipt", { hash: expectedHash });
      if (receipt) {
        const success = BigInt(receipt.status) === 1n;
        return { hash: expectedHash, success, receipt, attempts: attempt };
      }
      await sleep(Math.min(500 * attempt, 2500));
    }
    const error = new Error("Receipt timeout; transaction remains pending and must be reconciled by hash");
    error.pendingHash = expectedHash;
    throw error;
  }

  encode(abi, functionName, args = []) {
    return encodeFunctionData({ abi, functionName, args });
  }
}

export { formatUnits, getAddress, hexToBigInt, isAddress, parseUnits };

import { readFile } from "node:fs/promises";
import solc from "solc";
import { encodeDeployData, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AtlanticChain } from "../src/chain.js";

const RPC = "https://atlantic.dplabs-internal.com";
const API = "https://api-test.pharosnetwork.xyz";
const DOMAIN = "https://port.pharos.xyz";
const privateKey = process.env.EXECUTOR_PRIVATE_KEY || generatePrivateKey();
const account = privateKeyToAccount(privateKey);

async function api(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: DOMAIN,
      referer: `${DOMAIN}/faucet/`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) throw new Error(`Official faucet API ${path}: ${data.msg || response.status}`);
  return data.data;
}

async function loginAndFund() {
  const chain = new AtlanticChain({ rpcUrl: RPC, privateKey });
  const initial = await chain.session((mcp) => mcp.call("get_balance", { address: account.address }));
  console.error(`DEMO_SIGNER_ADDRESS=${account.address}`);
  console.error(`BALANCE_BEFORE_FAUCET=${initial.balance} ${initial.symbol}`);
  if (BigInt(initial.balanceWei) > 0n) return { chain, balance: initial, faucet: "skipped; already funded" };
  let faucet = "official Pharos Port faucet accepted";
  try {
    const challengeData = await api(`/omni_port/auth/challenge?address=${account.address}`);
    const challenge = challengeData.challenge;
    const issuedAt = new Date().toISOString();
    const message = [`${DOMAIN} wants you to sign in with your Ethereum account:`, account.address, "", `URI: ${DOMAIN}`, "", "Version: 1", "", "Chain ID: 688689", "", `Challenge: ${challenge}`, "", `Issued At: ${issuedAt}`].join("\n");
    const signature = await account.signMessage({ message });
    const login = await api("/omni_port/login", {
      method: "POST",
      body: { address: account.address, signature, wallet: "Codex Demo Signer", challenge, chain_id: "688689", timestamp: issuedAt, domain: DOMAIN, source: "port" },
    });
    await api("/omni_port/faucets/daily", { method: "POST", token: login.jwt, body: { address: account.address, recaptcha_token: "" } });
  } catch (error) {
    faucet = `official faucet could not auto-complete: ${error.message}; waiting for external testnet funding`;
    console.error(`FUNDING_REQUIRED=${account.address}`);
    console.error(faucet);
  }
  for (let i = 0; i < 240; i += 1) {
    const balance = await chain.session((mcp) => mcp.call("get_balance", { address: account.address }));
    if (BigInt(balance.balanceWei) > 0n) return { chain, balance, faucet };
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error(`Demo signer remains unfunded after ten minutes: ${account.address}`);
}

function compile(source) {
  const input = { language: "Solidity", sources: { "SagaDemo.sol": { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  return output.contracts["SagaDemo.sol"];
}

async function deploy(chain, artifact, args = []) {
  const data = encodeDeployData({ abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}`, args });
  return chain.session(async (mcp) => {
    let estimate;
    const tx = await chain.send(mcp, { data, onHash: async (_hash, meta) => { estimate = meta; } });
    if (!tx.success || !tx.receipt.contractAddress) throw new Error("Contract deployment failed");
    const code = await mcp.call("get_code", { address: tx.receipt.contractAddress, block: tx.receipt.blockNumber });
    if (!code.code || code.code === "0x") throw new Error("Deployment receipt succeeded but bytecode verification failed");
    return { address: tx.receipt.contractAddress, txHash: tx.hash, blockNumber: Number(BigInt(tx.receipt.blockNumber)), status: Number(BigInt(tx.receipt.status)), estimate };
  });
}

const source = await readFile(new URL("../contracts/SagaDemo.sol", import.meta.url), "utf8");
const artifacts = compile(source);
const funded = await loginAndFund();
const token = await deploy(funded.chain, artifacts.SagaTestToken, [parseUnits("1000", 18)]);
const escrow = await deploy(funded.chain, artifacts.SagaEscrow, [token.address, account.address]);
const vault = await deploy(funded.chain, artifacts.SagaTestVault, [token.address, escrow.address, account.address]);

console.log(JSON.stringify({
  network: "Pharos Atlantic Testnet", chainId: 688689, explorer: "https://atlantic.pharosscan.xyz",
  signer: account.address,
  fundedBalance: `${funded.balance.balance} ${funded.balance.symbol}`,
  funding: funded.faucet,
  contracts: { token, escrow, vault },
  cloudflareSecretStored: process.env.EXECUTOR_PRIVATE_KEY ? "stored before bootstrap by caller" : false,
}, null, 2));

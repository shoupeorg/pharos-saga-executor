import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseUnits } from "viem";
import { newSaga, executeDepositStep, executeSaga, retryRead } from "../src/saga.js";
import { parseAmount } from "../src/chain.js";
import { MemorySagaStore } from "../src/store.js";

const OWNER = "0xf2039216c4320CFFC5FB1B704642f9a706b95eE2";
const CONTRACTS = {
  token: "0x656BB1Bced876e304DCe2c8d98DDC9B1a08E928f",
  escrow: "0x8fFD7d13D2396BfdD9FBa98FCbDDb08d5475c820",
  vault: "0x99CD6A4948F10bEf67c20203c012706d7336aa38",
  tokenAbi: [], escrowAbi: [], vaultAbi: [],
};

class FakeChain {
  constructor({ recoveryFails = false } = {}) {
    this.account = { address: OWNER };
    this.balance = parseUnits("100", 18);
    this.allowance = 0n;
    this.credit = 0n;
    this.escrow = { owner: "0x0000000000000000000000000000000000000000", amount: 0n, status: 0 };
    this.reject = false;
    this.recoveryFails = recoveryFails;
    this.sent = [];
  }
  async session(fn) { return fn({ call: async () => null }, { chainId: 688689, latestBlock: 123 }); }
  encode(_abi, functionName, args) { return { functionName, args }; }
  async read(_mcp, _address, _abi, functionName) {
    if (functionName === "allowance") return this.allowance;
    if (functionName === "rejectSaga") return this.reject;
    throw new Error(`unexpected read: ${functionName}`);
  }
  async snapshot() {
    const escrowBalance = this.escrow.status === 1 ? this.escrow.amount : 0n;
    return {
      owner: OWNER, symbol: "SGT", decimals: 18,
      ownerBalanceRaw: this.balance.toString(), ownerBalance: "100",
      allowanceRaw: this.allowance.toString(), allowance: "0",
      vaultAllowanceRaw: "0", vaultAllowance: "0",
      escrowBalanceRaw: escrowBalance.toString(), escrowBalance: "0",
      vaultCreditRaw: this.credit.toString(), vaultCredit: "0",
      escrow: { owner: this.escrow.owner, amountRaw: this.escrow.amount.toString(), amount: "0", status: this.escrow.status },
    };
  }
  async preflight() {
    if (this.reject) throw new Error("execution reverted: FORCED_REJECT");
    return { gas: "60000" };
  }
  async send(_mcp, { data, onHash }) {
    const hash = `0x${String(this.sent.length + 1).padStart(64, "0")}`;
    await onHash(hash, { nonce: String(this.sent.length), rawPersistedBeforeBroadcast: true });
    this.sent.push(data.functionName);
    const [a, b, c] = data.args || [];
    if (data.functionName === "setReject") this.reject = b;
    if (data.functionName === "approve") this.allowance = b;
    if (data.functionName === "lock") {
      this.balance -= c; this.allowance -= c;
      this.escrow = { owner: b, amount: c, status: 1 };
    }
    if (data.functionName === "deposit") {
      this.credit += this.escrow.amount;
      this.escrow.status = 2;
    }
    if (data.functionName === "refund") {
      if (this.recoveryFails) throw new Error("temporary recovery transport failure");
      this.balance += this.escrow.amount;
      this.escrow.status = 3;
    }
    return { hash, success: true, receipt: { status: "0x1", blockNumber: "0x7b" } };
  }
  async sendKnownRevert(_mcp, { data, onHash, gasLimit }) {
    const hash = `0x${String(this.sent.length + 1).padStart(64, "0")}`;
    await onHash(hash, { nonce: String(this.sent.length), gasLimit: gasLimit.toString(), maximumCostWei: "2500000000000000", knownRevert: true, rawPersistedBeforeBroadcast: true });
    this.sent.push(`${data.functionName}-revert`);
    return { hash, success: false, receipt: { status: "0x0", blockNumber: "0x7c", gasUsed: "0xc350" } };
  }
}

async function run(mode, chain = new FakeChain()) {
  const store = new MemorySagaStore();
  const amountRaw = parseUnits("1", 18);
  const record = newSaga({ id: `test-${mode}`, mode, owner: OWNER, amount: "1", amountRaw: amountRaw.toString(), chainId: 688689, contracts: CONTRACTS });
  await store.create(record);
  let result = record;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const operation = ["LOCKED", "DEPOSIT_PENDING"].includes(result.state) ? executeDepositStep : executeSaga;
    result = await operation({ store, record: result, chain, contracts: CONTRACTS });
    if (["COMPLETED", "RECOVERED", "RECOVERY_REQUIRED", "ERROR"].includes(result.state)) break;
  }
  return { result, chain, store };
}

test("exact decimal amount parsing enforces boundaries without Number", () => {
  assert.equal(parseAmount("0.000000000000000001", 18, "10"), 1n);
  assert.equal(parseAmount("10", 18, "10"), parseUnits("10", 18));
  assert.throws(() => parseAmount("10.000000000000000001", 18, "10"), /maximum/);
  assert.throws(() => parseAmount("1e-18", 18, "10"), /decimal string/);
});

test("bounded transient read retry succeeds on third attempt", async () => {
  let calls = 0;
  const waits = [];
  const attempts = [];
  const value = await retryRead("probe", async () => {
    calls += 1;
    if (calls < 3) throw new Error("temporary network timeout");
    return "ok";
  }, async (attempt) => attempts.push(attempt), [0, 250, 750], async (ms) => waits.push(ms));
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 750]);
  assert.deepEqual(attempts.map((entry) => entry.attempt), [1, 2]);
  assert.ok(attempts.every((entry) => entry.transient));
});

test("three-step success verifies and completes once", async () => {
  const { result, chain } = await run("success");
  assert.equal(result.state, "COMPLETED");
  assert.deepEqual(chain.sent, ["approve", "lock", "deposit"]);
  assert.equal(chain.credit, parseUnits("1", 18));
  assert.equal(chain.allowance, 0n);
});

test("forced permanent failure refunds and revokes", async () => {
  const { result, chain } = await run("failure");
  assert.equal(result.state, "RECOVERED");
  assert.deepEqual(chain.sent, ["setReject", "approve", "lock", "refund", "approve"]);
  assert.equal(chain.balance, parseUnits("100", 18));
  assert.equal(chain.allowance, 0n);
  assert.equal(result.compensation.complete, true);
});

test("published retry evidence matches deterministic simulated result", async () => {
  const recorded = JSON.parse(await readFile(new URL("../evidence/retry-simulation.json", import.meta.url), "utf8"));
  const deployed = JSON.parse(await readFile(new URL("../public/retry-simulation.json", import.meta.url), "utf8"));
  assert.deepEqual(deployed, recorded);
  assert.equal(recorded.label, "SIMULATED — NOT A REAL NETWORK OUTAGE");
  assert.deepEqual(recorded.attempts.map(({ attempt, delayMs, classification }) => ({ attempt, delayMs, classification })), [
    { attempt: 1, delayMs: 0, classification: "TRANSIENT" },
    { attempt: 2, delayMs: 250, classification: "TRANSIENT" },
    { attempt: 3, delayMs: 750, classification: "SUCCESS" },
  ]);
  assert.equal(recorded.reconciliation.duplicateStateChangingOperations, 0);
});

test("receipt-verified forced failure mines status zero then recovers", async () => {
  const { result, chain } = await run("failure-broadcast");
  assert.equal(result.state, "RECOVERED");
  assert.deepEqual(chain.sent, ["setReject", "approve", "lock", "deposit-revert", "refund", "approve"]);
  assert.equal(result.transactions.deposit.receipt.status, "0x0");
  assert.equal(result.transactions.deposit.outcome, "EXPECTED_REVERT");
  assert.equal(chain.balance, parseUnits("100", 18));
  assert.equal(chain.allowance, 0n);
  assert.equal(result.observations.after.escrowBalanceRaw, "0");
  assert.equal(result.compensation.complete, true);
});

test("failed compensation remains RECOVERY_REQUIRED", async () => {
  const { result } = await run("failure", new FakeChain({ recoveryFails: true }));
  assert.equal(result.state, "RECOVERY_REQUIRED");
  assert.equal(result.compensation.complete, false);
});

test("resume does not repeat completed operations", async () => {
  const { result, chain, store } = await run("success");
  const sent = chain.sent.length;
  const again = await executeSaga({ store, record: result, chain, contracts: CONTRACTS });
  assert.equal(again.state, "COMPLETED");
  assert.equal(chain.sent.length, sent);
});

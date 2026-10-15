import { escrowAbi, tokenAbi, vaultAbi } from "./abis.js";
import { parseAmount, sagaKey } from "./chain.js";

export const FINAL_STATES = new Set(["COMPLETED", "RECOVERED"]);
export const RESUMABLE_STATES = new Set(["CREATED", "APPROVAL_PENDING", "APPROVED", "LOCK_PENDING", "LOCKED", "DEPOSIT_PENDING", "COMPENSATING", "RECOVERY_REQUIRED"]);

const transientPattern = /timeout|network|fetch|429|rate|temporar|503|502|connection/i;
const permanentPattern = /revert|FORCED_REJECT|execution reverted/i;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retryRead(label, operation, onAttempt = async () => {}, delays = [0, 250, 750]) {
  let last;
  for (let attempt = 1; attempt <= delays.length; attempt += 1) {
    if (delays[attempt - 1]) await wait(delays[attempt - 1]);
    try { return await operation(attempt); }
    catch (error) {
      last = error;
      await onAttempt({ label, attempt, error: error.message, transient: transientPattern.test(error.message) });
      if (!transientPattern.test(error.message) || attempt === delays.length) throw error;
    }
  }
  throw last;
}

function txSlot(record, name) {
  record.transactions[name] ||= { attempts: 0, hash: null, receipt: null, outcome: null };
  return record.transactions[name];
}

export function newSaga({ id, mode, owner, amount, amountRaw, chainId, contracts }) {
  const now = new Date().toISOString();
  return {
    id, mode, state: "CREATED", chainId, owner, amount, amountRaw,
    contracts, transactions: {}, observations: {}, errors: [], compensation: { required: false, complete: false },
    retryPolicy: { transientReadAttempts: 3, backoffMs: [0, 250, 750], stateChangingResubmission: "never blind; reconcile persisted hash, nonce and state" },
    timeline: [{ timestamp: now, state: "CREATED", event: "SAGA_CREATED", details: { mode, amount } }],
    createdAt: now, updatedAt: now,
  };
}

async function persistHash(store, record, name, hash, meta) {
  const slot = txSlot(record, name);
  slot.hash = hash;
  slot.attempts += 1;
  slot.submission = meta;
  await store.save(record);
  await store.log(record.id, record.state, "TX_HASH_PERSISTED", { step: name, hash, ...meta });
}

async function sendStep({ store, record, chain, mcp, name, to, data }) {
  const existing = txSlot(record, name);
  if (existing.receipt?.status === "0x1") return existing;
  if (existing.hash && !existing.receipt) {
    const receipt = await mcp.call("get_transaction_receipt", { hash: existing.hash });
    if (!receipt) {
      const error = new Error(`Existing ${name} transaction is still pending; reconcile ${existing.hash}`);
      error.pendingHash = existing.hash;
      throw error;
    }
    existing.receipt = receipt;
    existing.outcome = BigInt(receipt.status) === 1n ? "SUCCESS" : "REVERTED";
    await store.save(record);
    if (existing.outcome !== "SUCCESS") throw new Error(`${name} transaction reverted`);
    return existing;
  }
  const result = await chain.send(mcp, { to, data, onHash: (hash, meta) => persistHash(store, record, name, hash, meta) });
  existing.receipt = result.receipt;
  existing.outcome = result.success ? "SUCCESS" : "REVERTED";
  await store.save(record);
  if (!result.success) throw new Error(`${name} transaction reverted`);
  return existing;
}

async function verify(store, record, label, operation) {
  const result = await retryRead(label, operation, (attempt) => store.log(record.id, record.state, "READ_RETRY", attempt));
  await store.log(record.id, record.state, "STATE_VERIFIED", { label, result });
  return result;
}

async function compensate({ store, record, chain, mcp, contracts, reason }) {
  record.compensation.required = true;
  await store.transition(record, "COMPENSATING", "COMPENSATION_STARTED", { reason });
  try {
    const current = await chain.snapshot(mcp, contracts, record.id);
    if (current.escrow.status === 1) {
      await sendStep({ store, record, chain, mcp, name: "refund", to: contracts.escrow, data: chain.encode(escrowAbi, "refund", [sagaKey(record.id)]) });
    }
    await sendStep({ store, record, chain, mcp, name: "revoke", to: contracts.token, data: chain.encode(tokenAbi, "approve", [contracts.escrow, 0n]) });
    const final = await verify(store, record, "compensation-final-state", () => chain.snapshot(mcp, contracts, record.id));
    if (BigInt(final.allowanceRaw) !== 0n) throw new Error("Allowance cleanup verification failed");
    if (final.escrow.status !== 3 && current.escrow.status === 1) throw new Error("Refund state verification failed");
    record.observations.after = final;
    record.compensation.complete = true;
    await store.transition(record, "RECOVERED", "COMPENSATION_VERIFIED", { escrowStatus: final.escrow.status, allowanceRaw: final.allowanceRaw });
  } catch (error) {
    record.errors.push({ timestamp: new Date().toISOString(), phase: "compensation", message: error.message, pendingHash: error.pendingHash ?? null });
    await store.transition(record, "RECOVERY_REQUIRED", "COMPENSATION_INCOMPLETE", { error: error.message, pendingHash: error.pendingHash ?? null });
  }
}

export async function executeSaga({ store, record, chain, contracts }) {
  if (FINAL_STATES.has(record.state)) return record;
  return chain.session(async (mcp, chainInfo) => {
    record.chain = { name: "Atlantic Testnet", chainId: chainInfo.chainId, blockAtResume: chainInfo.latestBlock };
    record.observations.before ||= await verify(store, record, "initial-state", () => chain.snapshot(mcp, contracts, record.id));
    if (record.state === "RECOVERY_REQUIRED") {
      const recovered = await verify(store, record, "recovery-resume-state", () => chain.snapshot(mcp, contracts, record.id));
      if (recovered.escrow.status === 0 && BigInt(recovered.allowanceRaw) === 0n) {
        record.observations.after = recovered;
        record.compensation.required = true;
        record.compensation.complete = true;
        await store.transition(record, "RECOVERED", "COMPENSATION_VERIFIED_ON_RESUME", { escrowStatus: 0, allowanceRaw: "0" });
        return record;
      }
    }
    const amount = BigInt(record.amountRaw);
    try {
      if (record.mode === "failure" && !record.transactions.configureReject?.receipt) {
        await sendStep({ store, record, chain, mcp, name: "configureReject", to: contracts.vault, data: chain.encode(vaultAbi, "setReject", [sagaKey(record.id), true]) });
        const rejected = await verify(store, record, "forced-reject-enabled", () => chain.read(mcp, contracts.vault, vaultAbi, "rejectSaga", [sagaKey(record.id)]));
        if (!rejected) throw new Error("Forced reject flag was not confirmed");
        await store.transition(record, "CREATED", "FORCED_REJECT_VERIFIED", { enabled: true });
        return record;
      }

      const current = await chain.snapshot(mcp, contracts, record.id);
      if (current.escrow.status === 0 && !["APPROVED", "LOCK_PENDING"].includes(record.state)) {
        if (BigInt(current.allowanceRaw) < amount) {
          await store.transition(record, "APPROVAL_PENDING", "STEP_STARTED", { step: "approve" });
          await sendStep({ store, record, chain, mcp, name: "approve", to: contracts.token, data: chain.encode(tokenAbi, "approve", [contracts.escrow, amount]) });
        }
        const allowance = await verify(store, record, "allowance", () => chain.read(mcp, contracts.token, tokenAbi, "allowance", [record.owner, contracts.escrow]));
        if (allowance < amount) throw new Error("Approval receipt succeeded but allowance is insufficient");
        await store.transition(record, "APPROVED", "STEP_VERIFIED", { step: "approve", allowanceRaw: allowance.toString() });
        return record;
      }

      if (current.escrow.status === 0) {
        await store.transition(record, "LOCK_PENDING", "STEP_STARTED", { step: "lock" });
        await sendStep({ store, record, chain, mcp, name: "lock", to: contracts.escrow, data: chain.encode(escrowAbi, "lock", [sagaKey(record.id), record.owner, amount]) });
      }

      const locked = await verify(store, record, "escrow-locked", () => chain.snapshot(mcp, contracts, record.id));
      if (locked.escrow.status !== 1 || BigInt(locked.escrow.amountRaw) !== amount) throw new Error("Lock receipt succeeded but escrow state is invalid");
      await store.transition(record, "LOCKED", "STEP_VERIFIED", { step: "lock", escrow: locked.escrow });
      return record;
    } catch (error) {
      record.errors.push({ timestamp: new Date().toISOString(), phase: record.state, message: error.message, pendingHash: error.pendingHash ?? null, reconciliation: error.reconciliation ?? null });
      await store.save(record);
      const state = await chain.snapshot(mcp, contracts, record.id).catch(() => null);
      if (state?.escrow?.status === 1 || BigInt(state?.allowanceRaw || "0") > 0n) {
        await compensate({ store, record, chain, mcp, contracts, reason: error.message });
      } else if (error.pendingHash) {
        await store.transition(record, "RECOVERY_REQUIRED", "PENDING_RECONCILIATION", { hash: error.pendingHash, error: error.message });
      } else {
        await store.transition(record, "ERROR", "SAGA_FAILED_BEFORE_LOCK", { error: error.message });
      }
      return record;
    }
  });
}

export async function executeDepositStep({ store, record, chain, contracts }) {
  if (FINAL_STATES.has(record.state)) return record;
  return chain.session(async (mcp, chainInfo) => {
    record.chain = { name: "Atlantic Testnet", chainId: chainInfo.chainId, blockAtResume: chainInfo.latestBlock };
    const amount = BigInt(record.amountRaw);
    try {
      await store.transition(record, "DEPOSIT_PENDING", "STEP_STARTED", { step: "deposit" });
      const depositData = chain.encode(escrowAbi, "deposit", [sagaKey(record.id), contracts.vault]);

      if (record.mode === "failure") {
        try {
          await chain.preflight(mcp, { to: contracts.escrow, data: depositData });
          throw new Error("Forced-failure preflight unexpectedly passed");
        } catch (error) {
          if (!permanentPattern.test(error.message)) throw error;
          record.errors.push({ timestamp: new Date().toISOString(), phase: "deposit-preflight", classification: "PERMANENT", message: error.message });
          await store.log(record.id, record.state, "PERMANENT_FAILURE_CONFIRMED", { method: "MCP estimate_gas", error: error.message });
          await compensate({ store, record, chain, mcp, contracts, reason: error.message });
          return record;
        }
      }

      await sendStep({ store, record, chain, mcp, name: "deposit", to: contracts.escrow, data: depositData });
      const final = await verify(store, record, "deposit-final-state", () => chain.snapshot(mcp, contracts, record.id));
      const beforeCredit = BigInt(record.observations.before.vaultCreditRaw);
      if (final.escrow.status !== 2 || BigInt(final.vaultCreditRaw) - beforeCredit !== amount || BigInt(final.allowanceRaw) !== 0n) {
        throw new Error("Deposit receipt succeeded but expected vault/escrow/allowance state was not confirmed");
      }
      record.observations.after = final;
      await store.transition(record, "COMPLETED", "SAGA_COMPLETED", { escrowStatus: final.escrow.status, vaultCreditRaw: final.vaultCreditRaw });
      return record;
    } catch (error) {
      record.errors.push({ timestamp: new Date().toISOString(), phase: record.state, message: error.message, pendingHash: error.pendingHash ?? null, reconciliation: error.reconciliation ?? null });
      await store.save(record);
      const state = await chain.snapshot(mcp, contracts, record.id).catch(() => null);
      if (state?.escrow?.status === 1 || BigInt(state?.allowanceRaw || "0") > 0n) {
        await compensate({ store, record, chain, mcp, contracts, reason: error.message });
      } else if (error.pendingHash) {
        await store.transition(record, "RECOVERY_REQUIRED", "PENDING_RECONCILIATION", { hash: error.pendingHash, error: error.message });
      } else {
        await store.transition(record, "ERROR", "SAGA_FAILED_BEFORE_LOCK", { error: error.message });
      }
      return record;
    }
  });
}

export function parseSagaAmount(value, decimals, max) { return parseAmount(value, decimals, max); }

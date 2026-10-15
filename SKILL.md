---
name: pharos-saga-executor
description: Execute or recover a persistent approve-to-escrow-to-vault saga using valueless test tokens on Pharos Atlantic Testnet through the official Pharos Chain MCP implementation.
---

# Pharos Saga Executor

Use this Skill when a user asks to demonstrate a dependent, recoverable on-chain workflow on Pharos Atlantic Testnet.

## Safety contract

- Use Atlantic Testnet (`688689`) only.
- Use only the configured demo token, escrow, and vault.
- Never request, display, or return a private key.
- Never send mainnet transactions or user funds.
- Treat rollback as new compensating transactions; confirmed history cannot be reversed.
- Never resend a state-changing call while a persisted transaction hash is unresolved.

## Invoke

From the installed project directory:

```bash
npm install
npm run skill -- --mode=success --amount=1
npm run skill -- --mode=failure --amount=1
npm run skill -- --mode=failure-broadcast --amount=1
```

To resume an incomplete saga without repeating completed steps:

```bash
npm run skill -- --resume=SAGA_ID
```

Use `--url=https://your-worker.workers.dev` to target another authorized deployment.

## Expected behavior

1. Persist the saga before execution.
2. Estimate gas, sign locally on the server, persist the deterministic hash, and submit the raw transaction through `send_raw_transaction` on the official Pharos MCP implementation.
3. Verify each receipt and expected allowance/escrow/vault state before advancing.
4. Run at most one dependent state-changing step per request so the workflow remains restartable on the Workers Free plan.
5. Keep `failure` as the normal preflight-only rejection. Use `failure-broadcast` only when a user explicitly requests receipt-verified failure evidence; it is hard-restricted to chain 688689, the existing signer/contracts, at most 1 SGT, a 250,000 gas cap, and a preflight-confirmed `FORCED_REJECT`.
6. For `failure-broadcast`, require the failed deposit receipt status `0x0` before refund/revoke, then verify restored owner balance, zero owner and vault allowances, zero escrow token balance, unchanged vault credit, and `Refunded` status.
7. Report `RECOVERY_REQUIRED` rather than claiming recovery if any required receipt or compensation check is unconfirmed.

See [references/state-machine.md](references/state-machine.md) for state and retry rules and [README.md](README.md) for deployed addresses and evidence.

# Pharos Saga Executor

A persistent, recoverable three-step on-chain workflow for the Pharos Agent Arena **Saga Executor** task. The demo approves valueless `SGT`, locks it in a saga escrow, and deposits it into a controlled test vault for the original owner. A second mode makes the vault reject one saga and demonstrates real compensating refund and allowance-revoke transactions.

**Live demo:** https://pharos-saga-executor.shoupeorg.workers.dev/

## Safety and network

- Network: **Pharos Atlantic Testnet**
- Chain ID: `688689`
- Explorer: https://atlantic.pharosscan.xyz/
- Official network reference: https://docs.pharos.xyz/getting-started/network/atlantic-testnet
- Official MCP source: https://github.com/PharosNetwork/pharos-mcp
- Official Skill guide: https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide
- Test token: valueless `SGT`; no mainnet assets or user wallet are used.
- The dedicated signer is a Cloudflare Worker secret. The application exposes only its public address.

The public hosted MCP endpoint is mainnet-configured. For Atlantic, this project embeds an unmodified compiled copy of the official `pharos-mcp` server and RPC adapter and creates an in-memory MCP client/server transport configured with the official Atlantic RPC. Application chain operations call MCP tools only; there is no application-level direct-RPC fallback. `viem` signs locally on the server, and only the signed raw bytes are submitted through MCP `send_raw_transaction`.

## Deployed contracts

| Contract | Address | Deployment transaction |
|---|---|---|
| Saga Test Token | `0x656BB1Bced876e304DCe2c8d98DDC9B1a08E928f` | [`0x0572…e14a`](https://atlantic.pharosscan.xyz/tx/0x0572b5a1b51dac7ee6db201f4acdb1c72af63f0c9c59d71c13a7e61fe26ce14a) |
| Saga Escrow | `0x8fFD7d13D2396BfdD9FBa98FCbDDb08d5475c820` | [`0x7472…8ee6`](https://atlantic.pharosscan.xyz/tx/0x7472b7913b2fb5463f3803d88ddfdc7957ba724ba8ff6e9d55675b9a57758ee6) |
| Controlled Test Vault | `0x99CD6A4948F10bEf67c20203c012706d7336aa38` | [`0x97e1…5dfc`](https://atlantic.pharosscan.xyz/tx/0x97e13bdc634ccf10b3c55730516ed4703b518b560778452fcbb56c42fc465dfc) |

The escrow accepts lock/deposit only from the immutable authorized executor. The original owner or executor can refund a locked saga, so funds remain recoverable if the off-chain executor stops. Saga IDs cannot be replayed. The vault accepts deposits only from escrow and credits the original owner.

## Install and test

Requires Node.js 20 or newer.

```bash
npm install
npm run check
npm run build
```

Local Worker development additionally requires a D1 database and `.dev.vars` containing `EXECUTOR_PRIVATE_KEY`. Never commit that file.

```bash
npx wrangler d1 migrations apply pharos-saga-executor-state --local
npm run dev
```

## Skill usage

The installable Skill is at repository root: [`SKILL.md`](SKILL.md). Invoke the deployed workflow with the shared helper:

```bash
npm run skill -- --mode=success --amount=1
npm run skill -- --mode=failure --amount=1
npm run skill -- --resume=SAGA_ID
```

The web UI and helper call the same API and state-machine logic. Each request performs at most one dependent state-changing step, then persists and returns. This accommodates the Workers Free-plan subrequest limit and makes refresh/restart resumption explicit.

## MCP tools used

`get_chain_info`, `get_balance`, `get_transaction_count`, `get_gas_price`, `get_transaction`, `get_transaction_receipt`, `get_code`, `eth_call`, `estimate_gas`, and `send_raw_transaction`.

Every transaction is estimated before signing. The deterministic hash is persisted before broadcast. After an ambiguous submission, the executor checks that hash, its receipt, and the pending nonce. A receipt timeout leaves the saga pending; it does not trigger a blind resend.

## State and compensation

Normal path:

`CREATED → APPROVAL_PENDING → APPROVED → LOCK_PENDING → LOCKED → DEPOSIT_PENDING → COMPLETED`

Forced-failure path:

`… → LOCKED → DEPOSIT_PENDING → COMPENSATING → RECOVERED`

The controlled failure is a real on-chain `rejectSaga` flag. The deposit is not broadcast after MCP `estimate_gas` confirms `FORCED_REJECT`. Compensation then sends a refund and allowance revoke and verifies receipt status, owner balance, escrow status, and zero allowance. Rollback means these new transactions; it does not reverse confirmed chain history. Incomplete compensation remains `RECOVERY_REQUIRED` and can be resumed.

Transient read/transport errors retry up to three times with 0, 250, and 750 ms backoff. Confirmed contract reverts are permanent and are not retried as transient errors.

## Recorded real evidence

These are immutable recorded Atlantic snapshots, not simulations. Full compact records are in [`evidence/success.json`](evidence/success.json) and [`evidence/forced-failure.json`](evidence/forced-failure.json).

### Successful saga

- Saga: `saga-success-1792059526471-9f8d19bd`
- Recorded: `2026-10-15T10:19:13.818Z`
- Amount: `1 SGT`
- Approve: [`0xe65c…cf08`](https://atlantic.pharosscan.xyz/tx/0xe65c6af1073b0b3be804118aa0391cb8c660c2c08e6540edba1464c7d79acf08), block `31450998`, status `1`
- Lock: [`0xf311…d72d`](https://atlantic.pharosscan.xyz/tx/0xf311775e26ceb27ab5e3f226eb86f2c0d010e40c0d25859e23295e4bb83ad72d), block `31451006`, status `1`
- Deposit: [`0x46b5…7c5a`](https://atlantic.pharosscan.xyz/tx/0x46b54b978866b294dbc2b1c904bc4001861b1ba18de1f6b3cfc6d09da6297c5a), block `31451013`, status `1`
- Final: `COMPLETED`; owner `999 SGT`, vault credit `1 SGT`, allowance `0`, escrow status `Deposited`.

### Forced failure and recovery

- Saga: `saga-failure-1792059571639-f00504be`
- Recorded: `2026-10-15T10:21:13.165Z`
- Real controlled reject: [`0x94cf…4c15`](https://atlantic.pharosscan.xyz/tx/0x94cf0e832122a86bb659d5e89a3527917c9f9d2c480f80c6e37a4137bbc94c15), status `1`
- Deposit preflight: `execution reverted: FORCED_REJECT` through MCP `estimate_gas`; no doomed deposit transaction was broadcast.
- Refund: [`0xe118…6822`](https://atlantic.pharosscan.xyz/tx/0xe1182eabff9db112ab0de0a97954310770535d5cf4566dec249bddfbcf656822), block `31451102`, status `1`
- Revoke: [`0x7fc8…48dd`](https://atlantic.pharosscan.xyz/tx/0x7fc89e3004d52cf6f46e5c9f0b73628ce997bf37c11f80186b17199c22a048dd), block `31451106`, status `1`
- Final: `RECOVERED`; owner balance restored to `999 SGT`, vault credit unchanged at `1 SGT`, allowance `0`, escrow status `Refunded`.

## Verification performed

- Solidity compiled with `solc 0.8.30`; deployment bytecode was checked at each receipt block through MCP `get_code`.
- Six local tests: exact decimal boundaries, bounded transient retry, three-step success, forced failure/refund/revoke, `RECOVERY_REQUIRED`, and duplicate-free resume.
- Real success and forced-failure paths verified in the deployed API and UI.
- At historical locked-state block `31451091`, read-only MCP `eth_call` checks from an unrelated address rejected refund with `NOT_AUTHORIZED` and deposit with `NOT_EXECUTOR`; see [`evidence/authorization-checks.json`](evidence/authorization-checks.json). No transaction was broadcast for these checks.
- Replacement signer: 13 confirmed transactions, no pending nonce, `2,133,013` gas used at 10 gwei = `0.02133013 PHRS`; remaining balance `0.07866987 PHRS`.

## Submission audit and recorded-run video

The successful run advanced only after each receipt and post-state check:

| Step | Transaction | Receipt | Gate before the next step |
| --- | --- | --- | --- |
| Approve | `0xe65c6af1073b0b3be804118aa0391cb8c660c2c08e6540edba1464c7d79acf08` | status `1`, block `31450998` | MCP `eth_call` confirmed allowance `1000000000000000000` raw SGT. |
| Lock | `0xf311775e26ceb27ab5e3f226eb86f2c0d010e40c0d25859e23295e4bb83ad72d` | status `1`, block `31451006` | Snapshot confirmed escrow status `Locked`, the signer as owner, and exactly `1 SGT`. |
| Deposit | `0x46b54b978866b294dbc2b1c904bc4001861b1ba18de1f6b3cfc6d09da6297c5a` | status `1`, block `31451013` | Snapshot confirmed escrow status `Deposited`, vault-credit increase of `1 SGT`, and allowance `0`. |

Application-level read retries recognize error messages containing `timeout`, `network`, `fetch`, `429`, `rate`, `temporar`, `503`, `502`, or `connection`. They make at most three attempts with delays of `0`, `250`, and `750` ms. The local retry test deliberately injects two simulated `temporary network timeout` errors and succeeds on attempt three; it is **simulated test evidence, not a real Atlantic outage**. No transient network failure occurred in the recorded real sagas.

State-changing operations are never blindly retried. The locally derived transaction hash, nonce, estimate, gas limit, and gas price are persisted before broadcast. An ambiguous submission checks the expected transaction, receipt, and pending nonce. A receipt timeout leaves the hash pending for later reconciliation. Receipt polling is bounded to 24 checks with delays increasing from 500 ms to a 2.5-second cap.

The forced-failure record is different from an on-chain reverted deposit: MCP `estimate_gas` returned the permanent `execution reverted: FORCED_REJECT` error, so **no deposit transaction was broadcast**. Compensation used two new transactions: refund `0xe1182eabff9db112ab0de0a97954310770535d5cf4566dec249bddfbcf656822` and allowance cleanup `0x7fc89e3004d52cf6f46e5c9f0b73628ce997bf37c11f80186b17199c22a048dd`, both status `1`. The owner balance was `999 SGT` before and after this run, allowance returned to `0`, vault credit stayed `1 SGT`, and the saga escrow status became `Refunded` (`3`). The amount retained in the entry is historical accounting; status `Refunded` means it is no longer locked or held for the saga.

Record a short submission video without sending transactions:

1. Open the deployed demo and wait for `CONNECTED`. Do **not** press either `START` button.
2. Under `RECENT SAGAS`, open `saga-success-1792059526471-9f8d19bd` with `VIEW LOG`. Show the `COMPLETED` state, the persistent `STATE_VERIFIED` entries, all three transaction cards, attempt counts, status-`0x1` receipts, and the before/after balances. Open each transaction hash in the Atlantic explorer, then return to the demo.
3. Open `saga-failure-1792059571639-f00504be`. Show the `PERMANENT_FAILURE_CONFIRMED` log and recorded `execution reverted: FORCED_REJECT` error, emphasizing that it was an `estimate_gas` preflight and no deposit hash exists.
4. Show the confirmed refund and revoke transaction cards and explorer receipts. Show `RECOVERED`, before/after owner balance `999 SGT`, allowance `0`, vault credit unchanged at `1 SGT`, and escrow status `3` (`Refunded`).
5. Open this README’s retry section and `test/saga.test.js`. Show the three-attempt `0/250/750 ms` policy, hash/nonce reconciliation rules, and the simulated retry test. State explicitly that the retry test is simulated while the success and compensation receipts are real Atlantic evidence.
6. End on the demo history with both final states visible. No run, resume, wallet, or transaction action is needed.

## Limits

- This is a single dedicated Atlantic demo signer and valueless token, not a generalized custody service.
- Public operations are restricted to the deployed contracts, a maximum of `10 SGT`, and 20 saga steps per client per hour.
- D1 locking prevents concurrent execution of the same saga.
- The initial bootstrap attempt created three unusable contracts under an inaccessible in-memory signer. Its key was never exposed, but `0.08527358 PHRS` remains unrecoverable at that address; those contracts are not referenced by this application.
- `npm audit --omit=dev` reports GHSA-6qxp-vccf-f47h in the MCP SDK OAuth client with no published fix for the installed release. This project uses in-memory transport with no OAuth client, so the affected credential-forwarding path is not exercised.

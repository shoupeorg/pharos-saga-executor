# State machine and recovery rules

Normal path:

`CREATED → APPROVAL_PENDING → APPROVED → LOCK_PENDING → LOCKED → DEPOSIT_PENDING → COMPLETED`

Compensation path:

`DEPOSIT_PENDING → COMPENSATING → RECOVERED`

Receipt-verified controlled failure:

`LOCKED → DEPOSIT_PENDING → mined status 0x0 → COMPENSATING → RECOVERED`

This path is opt-in and restricted to Atlantic `688689`, the dedicated signer and deployed demo contracts, at most `1 SGT`, and a `250,000` failed-deposit gas limit. The normal forced-failure path remains preflight-only.

If compensation cannot be verified, the state is `RECOVERY_REQUIRED`. A resume reconciles the persisted hash and current contract state before doing anything else.

Transient reads retry at most three times with 0, 250, and 750 ms backoff. Confirmed reverts are permanent. Receipt timeouts retain the transaction hash as pending; the executor does not blindly resubmit it. Ambiguous submission errors reconcile the expected locally derived hash, receipt, transaction, and pending nonce.

The Free-plan Worker executes one verified state-changing saga step per HTTP request. The web interface and invocation helper automatically resume until a terminal state, while each step remains independently restartable.

# Calendar mutation ledger

One reviewed Calendar mutation keeps two durable rows: its approval and
its attempt. The calendar package's mutation ledger claims the attempt,
records the provider's receipt, and quarantines a claim whose outcome is
unknown until reconciliation or the owner settles it. A replay after a
restart reads the durable receipt and never calls the provider again.
The reviewed request binding comes from [reviewed reads](./reviewedReads.md)
and the approval service.

## Story: Run a reviewed Calendar change at most once and know what happened

> As the owner, I want a Calendar change I approved to reach my calendar
> at most once, and when the result is unclear I want to be asked rather
> than have it silently retried or reported as done.

### The approval and attempt rows always describe the same stage

An approved request has no attempt yet. An expired approval belongs to
an invalidated attempt. An executing attempt has an executing approval,
and a retryable attempt a retryable one. The approval is done exactly when the attempt
succeeded or the owner confirmed the outcome without a receipt, and it
requires reconciliation exactly when the attempt is ambiguous and the
owner has not confirmed it.

```quint
type ApprovalRow = Approved | ApprovalExecuting | Retryable | Expired | Done | ReconciliationRequired
type AttemptRow = Absent | Executing | FailedRetryable | Invalidated | Succeeded | Ambiguous
type MutationLedger = {
  approval: ApprovalRow, attempt: AttemptRow, generation: int, token: int,
  reconciliationAttempt: bool, ownerConfirmed: bool,
  attemptReceipt: int, reconciledReceipt: bool, refusedTokens: Set[int]
}
pure val initial: MutationLedger = {
  approval: Approved, attempt: Absent, generation: 0, token: 0,
  reconciliationAttempt: false, ownerConfirmed: false,
  attemptReceipt: 0, reconciledReceipt: false, refusedTokens: Set()
}
pure def alwaysPairedDurableRows(s: MutationLedger): bool =
  (s.attempt == Absent iff s.approval == Approved) and
  (s.attempt == Invalidated iff s.approval == Expired) and
  (s.attempt == Executing iff s.approval == ApprovalExecuting) and
  (s.attempt == FailedRetryable iff s.approval == Retryable) and
  (s.approval == Done iff (s.attempt == Succeeded or s.ownerConfirmed)) and
  (s.approval == ReconciliationRequired iff (s.attempt == Ambiguous and not(s.ownerConfirmed)))
```

### A claim takes a fresh token only from an approved or retryable request

A request can be claimed when it has no attempt and is approved, or
when its attempt failed in a retryable way. The claim marks both rows
executing and takes the next generation as its token. An unclaimed
request can instead be invalidated, which expires the approval. Generations count up from zero. Only a live claim holds a token: the token of an executing, ambiguous
or succeeded attempt is the latest generation, and an attempt that is
absent, retryable or invalidated holds none. An ambiguous attempt can
never be claimed again.

```quint
pure def claimable(s: MutationLedger): bool =
  (s.attempt == Absent and s.approval == Approved) or
  (s.attempt == FailedRetryable and s.approval == Retryable)
pure def canClaim(s: MutationLedger): bool = claimable(s)
pure def claim(s: MutationLedger): MutationLedger =
  { ...s, attempt: Executing, approval: ApprovalExecuting, generation: s.generation + 1,
    token: s.generation + 1, reconciliationAttempt: false }
pure def canInvalidateBeforeClaim(s: MutationLedger): bool = claimable(s)
pure def invalidateBeforeClaim(s: MutationLedger): MutationLedger = { ...s, attempt: Invalidated, approval: Expired }
pure def alwaysExactClaimToken(s: MutationLedger): bool =
  s.generation >= 0 and
  ((s.attempt == Executing or s.attempt == Ambiguous or s.attempt == Succeeded) implies s.token == s.generation and s.token > 0) and
  ((s.attempt == Absent or s.attempt == FailedRetryable or s.attempt == Invalidated) implies s.token == 0) and
  (s.approval == ReconciliationRequired implies s.reconciliationAttempt) and
  (s.attempt == Ambiguous implies not(claimable(s)))
pure def sometimesInvalidated(s: MutationLedger): bool = s.attempt == Invalidated and s.generation > 0
```

### Only the live claim's token can record a receipt, and a stale token changes no row

A receipt for the executing claim's own token marks the attempt
succeeded, the approval done, and stores that token as the durable
receipt. Any other token that was ever issued is refused: it is
remembered as refused and leaves both rows, the token and the receipt
as they were. The provider can also refuse the call, which makes the
attempt retryable and drops the token, or leave its outcome unknown,
which quarantines the attempt for reconciliation.

```quint
pure val tokenValues = Set(1, 2, 3)
pure def canRecordReceipt(s: MutationLedger, token: int): bool = token > 0 and token <= s.generation
pure def recordReceipt(s: MutationLedger, token: int): MutationLedger =
  if (s.attempt == Executing and token == s.token) { ...s, attempt: Succeeded, approval: Done, attemptReceipt: token }
  else { ...s, refusedTokens: s.refusedTokens.union(Set(token)) }
pure def canRecordRefusal(s: MutationLedger): bool = s.attempt == Executing
pure def recordRefusal(s: MutationLedger): MutationLedger = { ...s, attempt: FailedRetryable, approval: Retryable, token: 0 }
pure def canRecordUnknown(s: MutationLedger): bool = s.attempt == Executing
pure def recordUnknown(s: MutationLedger): MutationLedger =
  { ...s, attempt: Ambiguous, approval: ReconciliationRequired, reconciliationAttempt: true }
pure def stepRefusedTokenPreservesRows(before: MutationLedger, after: MutationLedger): bool =
  after.refusedTokens.size() != before.refusedTokens.size() implies
  after.attempt == before.attempt and after.approval == before.approval and after.token == before.token and
  after.attemptReceipt == before.attemptReceipt and after.reconciledReceipt == before.reconciledReceipt
pure def sometimesStaleTokenRefused(s: MutationLedger): bool = s.refusedTokens.size() > 0 and s.attempt == Executing
pure def sometimesSucceeded(s: MutationLedger): bool = s.attempt == Succeeded and not(s.reconciledReceipt)
pure val weight_recordReceipt = 3
```

### A restart quarantines an executing claim instead of retrying it

After a runtime restart, the ledger inspects its rows. A claim that was
still executing becomes ambiguous and requires reconciliation. Every
other row is left as it was, so a succeeded attempt is replayed from its
durable receipt without calling the provider.

```quint
pure def restartAndInspect(s: MutationLedger): MutationLedger =
  if (s.attempt == Executing) { ...s, attempt: Ambiguous, approval: ReconciliationRequired, reconciliationAttempt: true }
  else s
pure def stepRestartNeverClaims(before: MutationLedger, via: str, after: MutationLedger): bool =
  via == "restartAndInspect" implies after.generation == before.generation and after.attemptReceipt == before.attemptReceipt
pure def sometimesQuarantined(s: MutationLedger): bool = s.approval == ReconciliationRequired
```

### Reconciliation settles an ambiguous attempt from evidence or the owner's word

An ambiguous attempt that awaits reconciliation settles one of three
ways. Confirmed non-delivery makes it retryable with no token. The owner
can confirm the outcome without a receipt, which marks the approval done
and leaves the attempt ambiguous, so it can never be claimed again. A
receipt found at reconciliation counts only when it matches the exact
operation; it then becomes the durable receipt of that claim.

```quint
pure def awaitingReconciliation(s: MutationLedger): bool =
  s.attempt == Ambiguous and s.approval == ReconciliationRequired and s.reconciliationAttempt
pure def canConfirmNonDelivery(s: MutationLedger): bool = awaitingReconciliation(s)
pure def confirmNonDelivery(s: MutationLedger): MutationLedger = { ...s, attempt: FailedRetryable, approval: Retryable, token: 0 }
pure def canConfirmWithoutReceipt(s: MutationLedger): bool = awaitingReconciliation(s)
pure def confirmWithoutReceipt(s: MutationLedger): MutationLedger = { ...s, approval: Done, ownerConfirmed: true }
pure def canReconcileReceipt(s: MutationLedger): bool = awaitingReconciliation(s)
pure def reconcileReceipt(s: MutationLedger, matchesOperation: bool): MutationLedger =
  if (matchesOperation) { ...s, attempt: Succeeded, approval: Done, attemptReceipt: s.token, reconciledReceipt: true } else s
pure def sometimesOwnerConfirmed(s: MutationLedger): bool = s.ownerConfirmed
pure def sometimesReconciledReceipt(s: MutationLedger): bool = s.reconciledReceipt
pure def sometimesReclaimedAfterNonDelivery(s: MutationLedger): bool = s.generation >= 2 and s.attempt == Executing
```

### A replay needs a durable receipt, and a recorded receipt never changes

The attempt has succeeded exactly when it holds a receipt, and that
receipt is the claim's own token. A receipt taken at reconciliation
belongs to an attempt that was reconciled. An owner confirmation exists
only for an ambiguous attempt with no receipt. Once a receipt is
recorded, no later step changes it or its origin.

```quint
pure def alwaysReplayRequiresDurableReceipt(s: MutationLedger): bool =
  (s.attempt == Succeeded iff s.attemptReceipt != 0) and
  (s.reconciledReceipt implies s.attemptReceipt != 0 and s.reconciliationAttempt) and
  (s.attemptReceipt != 0 implies s.attemptReceipt == s.token) and
  (s.ownerConfirmed implies s.attempt == Ambiguous and s.attemptReceipt == 0)
pure def stepDurableReceiptIsImmutable(before: MutationLedger, after: MutationLedger): bool =
  before.attemptReceipt != 0 implies after.attemptReceipt == before.attemptReceipt and after.reconciledReceipt == before.reconciledReceipt
```

### A claim and a reconciliation each settle

Once the provider's callback is delivered, an executing claim does not
stay executing, and once evidence of non-delivery arrives, a
reconciliation does not stay pending. Both wait on that answer; nothing
is retried automatically.

```quint
pure val fair_recordRefusal = "weak"
pure val fair_recordUnknown = "weak"
pure val fair_confirmNonDelivery = "weak"
pure def leadsToClaimSettles(s: MutationLedger, later: MutationLedger): bool =
  s.attempt == Executing implies later.attempt != Executing
pure def leadsToReconciliationSettles(s: MutationLedger, later: MutationLedger): bool =
  s.approval == ReconciliationRequired implies later.approval != ReconciliationRequired
```

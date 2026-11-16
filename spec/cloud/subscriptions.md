# Subscriptions

An organization subscribes, changes plan, cancels or resumes through
commands that are reviewed, recorded and then dispatched to the payment
provider once. A checkout command settles when the payment is captured,
whether the provider's event arrives, the buyer returns, or a bounded
read-back finds it. A terminal provider event, such as the end of a
subscription, is applied exactly once under a lease and publishes the free
plan, its audit record and the notice together. Funding reserved for a plan
change is conserved until it settles. The review and authority checks a
native host applies before sending a cancel or undo are in
[host operations](./hostOperations.md).

## Story: Subscribe, change plan, cancel and undo without paying twice

> As an organization admin, I start a plan change and confirm it; it is
> sent to the payment provider once, a lost reply is recovered by reading
> it back rather than by charging again, and my plan follows the payment
> that actually happened.

### A command keeps the intent, return target and authority it was recorded with

The first request records the command for the organization's own
subscription with its provider key and request digest; a replay must match
them. A checkout started from a native client returns only to that
client's own registered billing return; every other command returns to the
web. A command from another organization or scope is refused.

```quint
type CommandKind = CheckoutKind | UpgradeKind | CancelKind | ResumeKind
type CommandPhase = CommandAbsent | CommandPrepared | CommandUnknown | CommandSucceeded | CommandFailed | CommandSuperseded | CommandApplied | CommandRetired
type ReturnTarget = WebReturn | OwnNativeReturn | OtherNativeReturn
type CheckoutSession = SessionMissing | SessionOpen | SessionComplete | SessionExpired
type WebhookState = NoWebhook | WebhookPending | WebhookLost | WebhookDelivered
type ReceiptPhase = ReceiptAbsent | ReceiptReceived | ReceiptProcessing | ReceiptApplied
type Subscription = {
  kind: CommandKind, command: CommandPhase, revision: int, generation: int, attempts: int, started: bool, responseDigest: int, returnTarget: ReturnTarget, applications: int,
  clock: int, session: CheckoutSession, fenced: bool, webhook: WebhookState, inspectedAt: int, reads: int,
  receipt: ReceiptPhase, lease: int, lastLease: int, leaseUntil: int, observed: bool, observedSource: int, draft: bool,
  sourceRevision: int, receiptRevision: int, terminal: bool, freePlan: bool, audited: bool, noticeQueued: bool, currentAuthority: bool
}
pure val initial: Subscription = {
  kind: CheckoutKind, command: CommandAbsent, revision: 0, generation: 0, attempts: 0, started: false, responseDigest: 0, returnTarget: WebReturn, applications: 0,
  clock: 0, session: SessionMissing, fenced: false, webhook: NoWebhook, inspectedAt: 0, reads: 0,
  receipt: ReceiptAbsent, lease: 0, lastLease: 0, leaseUntil: 0, observed: false, observedSource: 0, draft: false,
  sourceRevision: 1, receiptRevision: 0, terminal: false, freePlan: false, audited: false, noticeQueued: false, currentAuthority: true
}
pure def returnAllowed(kind: CommandKind, target: ReturnTarget): bool = target == WebReturn or (target == OwnNativeReturn and kind == CheckoutKind)
pure def canEnqueue(s: Subscription, kind: CommandKind, target: ReturnTarget, ownScope: bool, matchesIntent: bool): bool = s.command == CommandAbsent and ownScope and matchesIntent and returnAllowed(kind, target)
pure def enqueue(s: Subscription, kind: CommandKind, target: ReturnTarget, ownScope: bool, matchesIntent: bool): Subscription = { ...s, kind: kind, command: CommandPrepared, revision: 1, returnTarget: target }
pure def alwaysReturnStaysWithItsClient(s: Subscription): bool = returnAllowed(s.kind, s.returnTarget)
pure def stepIntentIsImmutable(before: Subscription, after: Subscription): bool = before.command != CommandAbsent implies (after.kind == before.kind and after.returnTarget == before.returnTarget)
```

### A command is dispatched once, at the exact revision and generation it was read at

Dispatch, resolution and supersession are compare-and-set writes on the
command's revision and generation; a stale write is refused. Cancel and
resume use their own dedicated dispatch and are not sent this way. A
prepared command may be superseded only before it was ever sent.

```quint
pure val revisionValues = Set(0, 1, 2, 3)
pure val generationValues = Set(0, 1)
pure val digestValues = Set(1, 2)
pure def genericKind(k: CommandKind): bool = k != CancelKind and k != ResumeKind
pure def canDispatch(s: Subscription, revision: int, generation: int): bool = genericKind(s.kind) and s.command == CommandPrepared and s.revision == revision and s.generation == generation
pure def dispatch(s: Subscription, revision: int, generation: int): Subscription = { ...s, command: CommandUnknown, revision: s.revision + 1, generation: s.generation + 1, attempts: s.attempts + 1, started: true }
pure def canResolve(s: Subscription, revision: int, generation: int, succeeded: bool, digest: int): bool = s.command == CommandUnknown and s.revision == revision and s.generation == generation and digest > 0
pure def resolve(s: Subscription, revision: int, generation: int, succeeded: bool, digest: int): Subscription =
  { ...s, command: if (succeeded) CommandSucceeded else CommandFailed, revision: s.revision + 1, responseDigest: if (succeeded) digest else 0 }
pure def canSupersede(s: Subscription, revision: int): bool = s.command == CommandPrepared and s.revision == revision
pure def supersede(s: Subscription, revision: int): Subscription = { ...s, command: CommandSuperseded, revision: s.revision + 1 }
pure def alwaysOneDispatch(s: Subscription): bool = s.attempts <= 1 and s.generation == s.attempts and (s.started == (s.attempts == 1))
pure def alwaysSupersededWasNeverSent(s: Subscription): bool = s.command == CommandSuperseded implies not(s.started)
pure def alwaysSucceededHasResponse(s: Subscription): bool = (s.command == CommandSucceeded) implies s.responseDigest > 0
pure def sometimesSuperseded(s: Subscription): bool = s.command == CommandSuperseded
```

### A captured checkout payment is applied once, by whichever path sees it first

The provider's event, the buyer's return and the recovery sweep all settle
the same checkout idempotently. The plan changes only for a captured
payment; a checkout whose session expired, or that was never created
within the provider's retry horizon, is retired, never a paid one.

```quint
pure val horizon = 10
pure val createSettle = 1
pure def awaitingPayment(s: Subscription): bool = s.kind == CheckoutKind and (s.command == CommandUnknown or s.command == CommandSucceeded)
pure def withPaidApplied(paid: bool, s: Subscription): Subscription = if (paid and awaitingPayment(s)) { ...s, command: CommandApplied, applications: s.applications + 1 } else s
pure def canTick(s: Subscription): bool = true
pure def tick(s: Subscription): Subscription = { ...s, clock: s.clock + 1 }
pure def canFence(s: Subscription): bool = not(s.fenced)
pure def fence(s: Subscription): Subscription = { ...s, fenced: true }
pure def canMaterialize(s: Subscription): bool = s.started and s.session == SessionMissing and s.clock < horizon
pure def materialize(s: Subscription): Subscription = { ...s, session: SessionOpen }
pure def canPay(s: Subscription, delivered: bool): bool = s.session == SessionOpen
pure def pay(s: Subscription, delivered: bool): Subscription = { ...s, session: SessionComplete, webhook: if (delivered) WebhookPending else WebhookLost }
pure def canProviderExpires(s: Subscription): bool = s.session == SessionOpen
pure def providerExpires(s: Subscription): Subscription = { ...s, session: SessionExpired }
pure def canDeliverWebhook(s: Subscription): bool = s.webhook == WebhookPending
pure def deliverWebhook(s: Subscription): Subscription = withPaidApplied(true, { ...s, webhook: WebhookDelivered })
pure def canConfirmReturn(s: Subscription): bool = s.session == SessionComplete and awaitingPayment(s)
pure def confirmReturn(s: Subscription): Subscription = withPaidApplied(true, s)
pure def alwaysOneApplication(s: Subscription): bool = s.applications <= 1 and ((s.command == CommandApplied) == (s.applications == 1))
pure def alwaysAppliedOnlyWhenPaid(s: Subscription): bool = s.command == CommandApplied implies s.session == SessionComplete
pure def alwaysPaidNeverRetired(s: Subscription): bool = s.command == CommandRetired implies (s.session == SessionExpired or s.session == SessionMissing)
pure def sometimesAppliedWithoutWebhook(s: Subscription): bool = s.command == CommandApplied and s.webhook == WebhookLost
```

### The read-back sweep only observes, with backoff, and the closure sweep alone retires

For an organization that is not fenced and a checkout inside the
provider's retry horizon, the read-back lane looks at the session after a
first age and then with a growing wait (the age at the last look, clamped
between one and four ticks); it applies a captured payment and retires an
expired session but never expires, creates or closes one. The closure lane
handles fenced organizations and checkouts past the horizon: it expires a
payable session only for a fenced organization and retires a missing one
only after the create horizon has settled.

```quint
pure def clamp(value: int, low: int, high: int): int = if (value < low) low else if (value > high) high else value
pure def readBackDue(s: Subscription): bool = awaitingPayment(s) and not(s.fenced) and s.clock < horizon and s.clock >= 1 and s.clock >= s.inspectedAt + clamp(s.inspectedAt, 1, 4)
pure def stale(s: Subscription): bool = awaitingPayment(s) and (s.fenced or s.clock >= horizon)
pure def canReadBack(s: Subscription): bool = readBackDue(s)
pure def readBack(s: Subscription): Subscription = {
  val seen = if (s.session == SessionComplete) withPaidApplied(true, s) else if (s.session == SessionExpired) { ...s, command: CommandRetired } else { ...s, inspectedAt: s.clock }
  { ...seen, reads: s.reads + 1 }
}
pure def canCloseStale(s: Subscription): bool = stale(s)
pure def closeStale(s: Subscription): Subscription =
  if (s.session == SessionComplete) withPaidApplied(true, s)
  else if (s.session == SessionExpired) { ...s, command: CommandRetired }
  else if (s.session == SessionOpen and s.fenced) { ...s, session: SessionExpired, command: CommandRetired }
  else if (s.session == SessionMissing and s.clock >= horizon + createSettle) { ...s, command: CommandRetired }
  else { ...s, inspectedAt: s.clock }
pure def maxReads(age: int): int = if (age < 1) 0 else if (age < 2) 1 else if (age < 4) 2 else if (age < 8) 3 else 4
pure def alwaysReadBacksAreBounded(s: Subscription): bool = s.reads <= maxReads(s.clock)
pure def stepReadBackOnlyObserves(before: Subscription, via: str, after: Subscription): bool = via == "readBack" implies (after.session == before.session and not(before.fenced) and before.clock < horizon)
pure val fair_tick = "weak"
pure val fair_readBack = "weak"
pure val fair_closeStale = "weak"
pure def leadsToPaidCheckoutApplied(s: Subscription, later: Subscription): bool = (s.session == SessionComplete and awaitingPayment(s)) implies later.command == CommandApplied
```

## Story: End a subscription exactly once when the provider says it ended

> As an organization admin whose subscription ended at the provider, I see
> the free plan, an audit entry and one notice, all at once, and never a
> half-applied ending or a second one.

### A terminal event is applied only by the current lease holder against the state it observed

The event's receipt is recorded once. A worker leases it, observes the
provider, and stages the publication only if the account is active, the
authority is current and the subscription's revision is the one it
observed. The final commit re-checks the lease; an expired lease, a
failure or a rollback publishes nothing. A worker that cannot proceed
releases the receipt for retry.

```quint
pure val tokenValues = Set(1, 2, 3)
pure def ownsReceipt(s: Subscription, token: int): bool = s.receipt == ReceiptProcessing and token > 0 and s.lease == token and s.leaseUntil > s.clock
pure def withTerminalPublished(authority: bool, s: Subscription): Subscription = { ...s, sourceRevision: s.sourceRevision + 1, terminal: true, freePlan: authority, audited: true, noticeQueued: true }
pure def canRecordTerminalEvent(s: Subscription): bool = s.receipt == ReceiptAbsent
pure def recordTerminalEvent(s: Subscription): Subscription = { ...s, receipt: ReceiptReceived }
pure def canClaimReceipt(s: Subscription): bool = not(s.draft) and (s.receipt == ReceiptReceived or (s.receipt == ReceiptProcessing and s.leaseUntil <= s.clock))
pure def claimReceipt(s: Subscription): Subscription = { ...s, receipt: ReceiptProcessing, lease: s.lastLease + 1, lastLease: s.lastLease + 1, leaseUntil: s.clock + 2, observed: false, observedSource: s.sourceRevision }
pure def canObserveProvider(s: Subscription, token: int): bool = not(s.draft) and s.receipt == ReceiptProcessing and s.lease == token and not(s.observed)
pure def observeProvider(s: Subscription, token: int): Subscription = { ...s, observed: true }
pure def canReleaseReceipt(s: Subscription, token: int): bool = not(s.draft) and ownsReceipt(s, token)
pure def releaseReceipt(s: Subscription, token: int): Subscription = { ...s, receipt: ReceiptReceived, lease: 0, leaseUntil: 0, observed: false }
pure def canStageReceipt(s: Subscription, token: int): bool = ownsReceipt(s, token) and s.observed and not(s.draft) and not(s.fenced) and s.currentAuthority and s.observedSource == s.sourceRevision
pure def stageReceipt(s: Subscription, token: int): Subscription = { ...s, draft: true }
pure def canCommitReceipt(s: Subscription): bool = s.draft and ownsReceipt(s, s.lease)
pure def commitReceipt(s: Subscription): Subscription = {
  val published = if (s.terminal) s else withTerminalPublished(s.currentAuthority, s)
  { ...published, receipt: ReceiptApplied, receiptRevision: published.sourceRevision, lease: 0, leaseUntil: 0, observed: false, draft: false }
}
pure def canRollbackReceipt(s: Subscription): bool = s.draft
pure def rollbackReceipt(s: Subscription): Subscription = { ...s, draft: false, observed: false }
pure def alwaysProcessingHasLease(s: Subscription): bool = ((s.receipt == ReceiptProcessing) == (s.lease > 0)) and (s.draft implies s.receipt == ReceiptProcessing)
pure def alwaysAppliedReceiptNamesItsPublication(s: Subscription): bool = ((s.receipt == ReceiptApplied) == (s.receiptRevision > 0)) and (s.receipt == ReceiptApplied implies (s.terminal and s.receiptRevision == s.sourceRevision))
pure def stepAppliedReceiptIsFinal(before: Subscription, after: Subscription): bool = before.receipt == ReceiptApplied implies (after.receipt == ReceiptApplied and after.receiptRevision == before.receiptRevision)
pure def sometimesTerminalApplied(s: Subscription): bool = s.receipt == ReceiptApplied and s.freePlan
pure def sometimesLeaseTakenOver(s: Subscription): bool = s.receipt == ReceiptProcessing and s.lease >= 2
```

### The free plan, audit record and notice are published together, and only under the current authority

Recovery may publish the ending before the receipt does; the receipt then
records it without publishing again. Replacing the subscription's
authority withdraws the free plan but not the record of the ending.

```quint
pure def canAdvanceSource(s: Subscription): bool = not(s.draft) and s.currentAuthority and not(s.terminal)
pure def advanceSource(s: Subscription): Subscription = { ...s, sourceRevision: s.sourceRevision + 1 }
pure def canPublishViaRecovery(s: Subscription): bool = not(s.draft) and not(s.fenced) and s.currentAuthority and not(s.terminal)
pure def publishViaRecovery(s: Subscription): Subscription = withTerminalPublished(s.currentAuthority, s)
pure def canReplaceAuthority(s: Subscription): bool = not(s.draft) and s.currentAuthority
pure def replaceAuthority(s: Subscription): Subscription = { ...s, currentAuthority: false, freePlan: false }
pure def alwaysEndingPublishedWhole(s: Subscription): bool = s.terminal == s.audited and s.terminal == s.noticeQueued
pure def alwaysFreePlanOnlyUnderCurrentAuthority(s: Subscription): bool = s.freePlan == (s.terminal and s.currentAuthority)
pure val fair_commitReceipt = "weak"
pure val fair_rollbackReceipt = "weak"
pure def leadsToDraftFinishes(s: Subscription, later: Subscription): bool = s.draft implies not(later.draft)
```

## Story: Reserve funding for a plan change until it settles

> As an organization admin, the credits and included allowance backing a
> plan change are held until it settles, and every unit ends up used,
> released or expired, never counted twice.

### A funding reservation is conserved through settlement or cancellation and is final once settled

A reservation splits the requested amount between the period's included
allowance and purchased credits (a cash-only reservation uses no
allowance). Settlement records what was used; the rest of the allowance is
released, or expires if the period ended, and the rest of the purchased
credits is released. Cancellation uses nothing. A terminal reservation
replayed with its own key is unchanged, and its identity never changes.

```quint
type FundingStatus = FundingReserved | FundingFinalized | FundingCanceled
type Funding = { status: FundingStatus, key: int, allowance: int, purchased: int, usedAllowance: int, usedPurchased: int, releasedAllowance: int, releasedPurchased: int, expiredAllowance: int, overage: int }
pure def reserveFunding(allowance: int, purchased: int): Funding = { status: FundingReserved, key: 0, allowance: allowance, purchased: purchased, usedAllowance: 0, usedPurchased: 0, releasedAllowance: 0, releasedPurchased: 0, expiredAllowance: 0, overage: 0 }
pure def settleFunding(f: Funding, key: int, usedAllowance: int, usedPurchased: int, periodEnded: bool, overage: int): Funding =
  if (f.status != FundingReserved or usedAllowance < 0 or usedPurchased < 0 or usedAllowance > f.allowance or usedPurchased > f.purchased or overage < 0) f
  else { ...f, status: FundingFinalized, key: key, usedAllowance: usedAllowance, usedPurchased: usedPurchased,
    releasedAllowance: if (periodEnded) 0 else f.allowance - usedAllowance, expiredAllowance: if (periodEnded) f.allowance - usedAllowance else 0,
    releasedPurchased: f.purchased - usedPurchased, overage: overage }
pure def cancelFunding(f: Funding, key: int): Funding = if (f.status != FundingReserved) f else { ...f, status: FundingCanceled, key: key, releasedAllowance: f.allowance, releasedPurchased: f.purchased }
pure def conserved(f: Funding): bool = f.allowance >= 0 and f.purchased >= 0 and f.allowance + f.purchased > 0 and
  (if (f.status == FundingReserved) f.usedAllowance + f.usedPurchased + f.releasedAllowance + f.releasedPurchased + f.expiredAllowance == 0
   else f.allowance == f.usedAllowance + f.releasedAllowance + f.expiredAllowance and f.purchased == f.usedPurchased + f.releasedPurchased and (f.status == FundingCanceled implies f.usedAllowance + f.usedPurchased + f.overage == 0))
pure val fValues = Set(reserveFunding(1, 1), reserveFunding(0, 2), reserveFunding(2, 0), { ...reserveFunding(1, 1), status: FundingFinalized, key: 1, usedAllowance: 1, releasedPurchased: 1 })
pure val usedAllowanceValues = Set(0, 1, 2)
pure val usedPurchasedValues = Set(0, 1, 3)
pure val keyValues = Set(1, 2)
pure def lawSettlementConserves(f: Funding, key: int, usedAllowance: int, usedPurchased: int, periodEnded: bool): bool = conserved(f) implies conserved(settleFunding(f, key, usedAllowance, usedPurchased, periodEnded, 0))
pure def lawCancellationConserves(f: Funding, key: int): bool = conserved(f) implies conserved(cancelFunding(f, key))
pure def lawTerminalFundingIsFinal(f: Funding, key: int, usedAllowance: int, usedPurchased: int, periodEnded: bool): bool = f.status != FundingReserved implies (settleFunding(f, key, usedAllowance, usedPurchased, periodEnded, 0) == f and cancelFunding(f, key) == f)
pure def lawExpiredAllowanceIsNotReleased(f: Funding, key: int, usedAllowance: int, usedPurchased: int): bool = settleFunding(f, key, usedAllowance, usedPurchased, true, 0).releasedAllowance == (if (f.status == FundingReserved) 0 else f.releasedAllowance)
```

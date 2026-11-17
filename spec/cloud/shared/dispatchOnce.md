# Provider change dispatched once

One change the cloud makes at a provider (a checkout session, a subscription
update or schedule, a Gmail operation, a calendar write, a Google grant
revocation) is one `Receipt`, built on the kernel's once-only session
(`spec/core/sessions.md`). Owners embed a receipt in their own state and call
these transitions from theirs: `billing/checkout`,
`billing/subscriptionCommands`, `identity/deletion`,
`services/google/mailOperations` and `services/google/calendar`. Sources are
develop `packages/cloud/quint/PlatformSubscriptionCommand.qnt` (fence before
the call), `MailboxStarMutation.qnt` (one call, lost reply observed) and
`AccountDeletionPhase.qnt` (marker written before the call), and the receipt
ledger of the old `spec/cloud/managedGoogle/gmail.md`.

The session owner is `{agentId: organizationId, actorId: userId, connector:
kind}`, so the operation kind is the owner's connector and a receipt is
scoped to its organization, user and kind. The shell keys receipts by that
scope and the owner's request id, writes each transition in one store
transaction, and persists the claim and the send marker before any provider
I/O. Its provider call times out before the receipt's stale time. Answers say
`providerExactlyOnce: false`: the provider itself does not promise once.

## Story: Send a change once and recover its outcome without sending it again

> As an account owner, I want each change the cloud makes at a provider for
> me sent at most once, and its outcome found again after a lost reply, so
> that I am never charged, cancelled or mailed twice.

### A receipt binds its owner, request digest, provider key and stale time once

Preparing creates the session. Preparing again with the same owner (and so
the same kind) and digest answers the receipt as it stands, in whatever
state it has reached; another kind or digest is `409
idempotency_conflict` and leaves the receipt unchanged. The bindings never
change afterwards.

```quint
import types.* from "./types"
import sessions as S from "../../core/sessions"
type ReceiptOutcome = Unsettled | Succeeded | Refused | NotApplied
type Receipt = { session: S::Session, digest: str, providerKey: ProviderKey, staleAfter: Millis, claimedAt: Millis, sentAt: Millis, outcome: ReceiptOutcome }
pure val initial: Receipt = { session: S::initial, digest: "", providerKey: { kind: Checkout, id: "" }, staleAfter: 0, claimedAt: 0, sentAt: 0, outcome: Unsettled }
pure val digestValues = Set("d1", "d2")
pure val providerKeyValues = Set({ kind: Checkout, id: "key1" }, { kind: GmailOperation, id: "key2" })
pure val staleAfterValues = Set(2, 5)
pure def kindOf(r: Receipt): str = r.session.owner.connector
pure def canPrepare(r: Receipt, by: S::SessionOwner, digest: str, providerKey: ProviderKey, staleAfter: Millis, expiresAt: Millis): bool =
  if (r.session.phase == S::Absent) S::canCreate(r.session, by, expiresAt) and digest != "" and providerKey.id != "" and staleAfter > 0
  else r.session.owner == by and r.digest == digest
pure def prepare(r: Receipt, by: S::SessionOwner, digest: str, providerKey: ProviderKey, staleAfter: Millis, expiresAt: Millis): Receipt =
  if (r.session.phase == S::Absent) { ...r, session: S::create(r.session, by, expiresAt), digest: digest, providerKey: providerKey, staleAfter: staleAfter }
  else r
pure def isConflict(r: Receipt, by: S::SessionOwner, digest: str): bool = r.session.phase != S::Absent and not(r.session.owner == by and r.digest == digest)
pure val conflictRefusal: Refusal = refuse(IdempotencyConflict)
pure def stepBindingIsFixed(before: Receipt, after: Receipt): bool =
  before.session.phase != S::Absent implies (after.session.owner == before.session.owner and after.digest == before.digest and after.providerKey == before.providerKey and after.staleAfter == before.staleAfter)
```

### A receipt is claimed and committed before the provider is asked

The claim acquires the session and commits it in one transaction, before
any provider I/O, so a committed receipt is never claimable again; the
kernel's session rules hold of every receipt's session.

```quint
pure def canClaim(r: Receipt, by: S::SessionOwner, leaseDuration: int): bool = r.outcome == Unsettled and r.session.phase == S::Pending and S::canAcquire(r.session, by, r.digest, leaseDuration)
pure def claim(r: Receipt, by: S::SessionOwner, leaseDuration: int): Receipt = {
  val acquired = S::acquire(r.session, by, r.digest, leaseDuration)
  { ...r, session: S::commit(acquired, by, acquired.currentClaim, r.digest), claimedAt: r.session.now }
}
pure def canElapse(r: Receipt, elapsed: Millis): bool = S::canElapse(r.session, elapsed)
pure def elapse(r: Receipt, elapsed: Millis): Receipt = { ...r, session: S::elapse(r.session, elapsed) }
pure def alwaysSessionIsSound(r: Receipt): bool = S::alwaysEffectHasCommittedOwner(r.session) and S::alwaysAtMostOneInvocation(r.session) and S::alwaysCompletedHasOutcome(r.session) and S::alwaysLiveClaimHasToken(r.session) and S::alwaysClaimSequenceIsValid(r.session) and S::alwaysAmbiguousCommitRemainsDurable(r.session)
pure def stepCommitNeverReopens(before: Receipt, after: Receipt): bool = S::stepCommitNeverReopens(before.session, after.session)
```

### The provider is asked at most once, before the stale time, and only a clear reply settles the receipt

The send marker is the kernel's invocation. A reply showing the requested
effect settles `Succeeded`; a definite refusal settles `Refused`; anything
else, a lost reply included, leaves the receipt committed with an unknown
outcome and no sender still waiting. A process lost after the claim leaves
the same.

```quint
type ProviderReply = ShowsEffect | DefiniteRefusal | Unclear
pure def staleAt(r: Receipt): Millis = r.claimedAt + r.staleAfter
pure def canSend(r: Receipt, by: S::SessionOwner): bool = r.outcome == Unsettled and r.session.now < staleAt(r) and S::canInvoke(r.session, by, r.session.currentClaim)
pure def send(r: Receipt, by: S::SessionOwner, reply: ProviderReply): Receipt = {
  val invoked = S::invoke(r.session, by, r.session.currentClaim)
  val sent = { ...r, sentAt: r.session.now }
  if (reply == ShowsEffect) { ...sent, session: S::complete(S::recordOutcome(invoked)), outcome: Succeeded }
  else if (reply == DefiniteRefusal) { ...sent, session: S::complete(S::recordOutcome(invoked)), outcome: Refused }
  else { ...sent, session: S::loseExecutor(invoked) }
}
pure def canLoseExecutor(r: Receipt): bool = r.outcome == Unsettled and S::canLoseExecutor(r.session)
pure def loseExecutor(r: Receipt): Receipt = { ...r, session: S::loseExecutor(r.session) }
pure def alwaysSentBeforeStale(r: Receipt): bool = r.session.effects == 1 implies r.sentAt < staleAt(r)
pure def sometimesSucceededOnReply(r: Receipt): bool = r.outcome == Succeeded and r.session.executorAlive
pure def sometimesRefusedOnReply(r: Receipt): bool = r.outcome == Refused and r.session.executorAlive
pure def sometimesUnknownAfterLostReply(r: Receipt): bool = r.outcome == Unsettled and r.session.effects == 1
```

### An unknown outcome is settled only by a provider lookup under the same provider key

A lookup that sees the effect settles `Succeeded` and one that sees a
refusal settles `Refused`; both need the send marker. One that sees no
effect settles `NotApplied` only once the stale time has passed, which no
send can outlast. A lookup that cannot tell changes nothing and is tried
again later by the owner's sweep.

```quint
type LookupResult = EffectSeen | RefusalSeen | NothingSeen
pure def canResolve(r: Receipt, lookup: LookupResult): bool =
  r.outcome == Unsettled and r.session.phase == S::Committed and (if (lookup == NothingSeen) r.session.now >= staleAt(r) else r.session.effects == 1)
pure def resolve(r: Receipt, lookup: LookupResult): Receipt = {
  val outcome = if (lookup == EffectSeen) Succeeded else if (lookup == RefusalSeen) Refused else NotApplied
  { ...r, outcome: outcome, session: if (r.session.effects == 1) S::complete(S::recordOutcome(r.session)) else r.session }
}
pure def stepNotAppliedOnlyOnceStale(before: Receipt, after: Receipt): bool = (before.outcome == Unsettled and after.outcome == NotApplied) implies before.session.now >= staleAt(before)
pure def sometimesLookupFindsTheEffect(r: Receipt): bool = r.outcome == Succeeded and not(r.session.executorAlive)
pure def sometimesNotAppliedBeforeAnySend(r: Receipt): bool = r.outcome == NotApplied and r.session.effects == 0
pure def sometimesNotAppliedAfterLostReply(r: Receipt): bool = r.outcome == NotApplied and r.session.effects == 1
```

### A settled receipt is final and agrees with its session

`Succeeded` and `Refused` were sent and completed the session. `NotApplied`
completed it when a send marker exists, and otherwise leaves it committed,
where the kernel keeps it and no send can follow.

```quint
pure def alwaysOutcomeFollowsTheSession(r: Receipt): bool =
  (r.outcome == Unsettled implies r.session.phase != S::Completed)
  and ((r.outcome == Succeeded or r.outcome == Refused) implies (r.session.phase == S::Completed and r.session.effects == 1))
  and (r.outcome == NotApplied implies ((r.session.phase == S::Completed and r.session.effects == 1) or (r.session.phase == S::Committed and r.session.effects == 0)))
pure def stepSettledIsFinal(before: Receipt, after: Receipt): bool =
  before.outcome != Unsettled implies (after.outcome == before.outcome and after.session.phase == before.session.phase and after.session.effects == before.session.effects)
```

### A prepared receipt answers exactly one status

`StatusRejected` is `rejected` on the wire, with `rejectionCode`
`provider_refused` or `not_applied`. A committed receipt is unknown once its
reply was lost, its sender was lost or its stale time passed.

```quint
type ReceiptStatus = StatusPrepared | StatusDispatched | StatusUnknown | StatusSucceeded | StatusRejected
pure def receiptStatus(r: Receipt): ReceiptStatus =
  if (r.outcome == Succeeded) StatusSucceeded
  else if (r.outcome != Unsettled) StatusRejected
  else if (r.session.phase != S::Committed) StatusPrepared
  else if (r.session.effects == 1 or not(r.session.executorAlive) or r.session.now >= staleAt(r)) StatusUnknown
  else StatusDispatched
```

### Only a rejected receipt is followed by a new receipt, and always under a new provider key

A rejection means the provider did not apply the change, so an owner that
tries again prepares a new receipt with a provider key the rejected one did
not use. Nothing else is ever sent again.

```quint
pure def mayFollowWith(old: Receipt, providerKey: ProviderKey): bool = (old.outcome == Refused or old.outcome == NotApplied) and providerKey != old.providerKey
```

# Provider change dispatched once

One change the cloud makes at a provider (a checkout session, a subscription
update or schedule, a Gmail operation, a calendar write, a Google grant
revocation) is one `Receipt`, built on the kernel's once-only session
(`spec/core/sessions.md`). Owners embed a receipt in their own state and call
these transitions from theirs: `billing/checkout`,
`billing/subscriptionCommands`, `identity/deletion`,
`services/google/mailOperations` and `services/google/calendar`.

The session owner is `{agentId: organizationId, actorId: userId, connector}`,
where `connector` is the rendered kind of the provider key, so a receipt has
one kind. The shell keys receipts by organization, user and the owner's
request key; an owner folds any further scope into that key (mail uses
`grantId:requestId`). It writes each transition in one store transaction and
persists the claim and the send marker before any provider I/O. On the wire
`createdAt` is `preparedAt`, `dispatchedAt` is `sentAt` and `finishedAt` is
`settledAt`.

## Story: Send a change once and recover its outcome without sending it again

> As an account owner, I want each change the cloud makes at a provider for
> me sent at most once, and its outcome found again after a lost reply, so
> that I am never charged, cancelled or mailed twice.

### A receipt binds its owner, kind, request digest, provider key and stale time once

Preparing creates the session. A second prepare with the same request key
finds this receipt: with the same owner (and so the same kind) and digest it
answers the receipt as it stands, in whatever state it has reached; another
kind or digest is `409 idempotency_conflict` and leaves it unchanged.

```quint
import types.* from "./types"
import sessions as S from "../../core/sessions"
type Settlement = Unsettled | Succeeded | Refused | NotApplied
type Receipt = { session: S::Session, digest: str, providerKey: ProviderKey, staleAfter: Millis, preparedAt: Millis, sentAt: Millis, settledAt: Millis, settlement: Settlement }
pure val initial: Receipt = { session: S::initial, digest: "", providerKey: { providerKind: CheckoutSession, providerId: "" }, staleAfter: 0, preparedAt: 0, sentAt: 0, settledAt: 0, settlement: Unsettled }
pure val byValues = Set({ agentId: "org1", actorId: "user1", connector: "checkout_session" }, { agentId: "org1", actorId: "user1", connector: "gmail_operation" })
pure val digestValues = Set("d1", "d2")
pure val providerKeyValues = Set({ providerKind: CheckoutSession, providerId: "key1" }, { providerKind: GmailOperation, providerId: "key2" })
pure val staleAfterValues = Set(2, 5)
pure def connectorOf(kind: ProviderKind): str = match kind {
  | CheckoutSession => "checkout_session"
  | SubscriptionUpdate => "subscription_update"
  | SubscriptionSchedule => "subscription_schedule"
  | GmailOperation => "gmail_operation"
  | CalendarEvent => "calendar_event"
  | GoogleGrant => "google_grant"
}
pure def kindOf(r: Receipt): ProviderKind = r.providerKey.providerKind
pure def isConflict(r: Receipt, by: S::SessionOwner, digest: str): bool = r.session.phase != S::Absent and not(r.session.owner == by and r.digest == digest)
pure val conflictRefusal: Refusal = refuse(IdempotencyConflict)
pure def canPrepare(r: Receipt, by: S::SessionOwner, digest: str, providerKey: ProviderKey, staleAfter: Millis, expiresAt: Millis): bool =
  if (r.session.phase == S::Absent) S::canCreate(r.session, by, expiresAt) and digest != "" and providerKey.providerId != "" and by.connector == connectorOf(providerKey.providerKind) and staleAfter > 0
  else not(isConflict(r, by, digest))
pure def prepare(r: Receipt, by: S::SessionOwner, digest: str, providerKey: ProviderKey, staleAfter: Millis, expiresAt: Millis): Receipt =
  if (r.session.phase == S::Absent) { ...r, session: S::create(r.session, by, expiresAt), digest: digest, providerKey: providerKey, staleAfter: staleAfter, preparedAt: r.session.now }
  else r
pure def stepBindingIsFixed(before: Receipt, after: Receipt): bool =
  before.session.phase != S::Absent implies (after.session.owner == before.session.owner and after.digest == before.digest and after.providerKey == before.providerKey and after.staleAfter == before.staleAfter and after.preparedAt == before.preparedAt)
```

### A receipt is claimed and committed before the provider is asked, and its claim lease ends at its stale time

The claim acquires the session with a lease of `staleAfter` and commits it
in one transaction, so a committed receipt is never claimable again and its
stale time never moves. The kernel's session rules hold of every receipt.

```quint
pure def staleAt(r: Receipt): Millis = r.session.leaseUntil
pure def canClaim(r: Receipt, by: S::SessionOwner): bool = r.settlement == Unsettled and r.session.phase == S::Pending and S::canAcquire(r.session, by, r.digest, r.staleAfter)
pure def claim(r: Receipt, by: S::SessionOwner): Receipt = {
  val acquired = S::acquire(r.session, by, r.digest, r.staleAfter)
  { ...r, session: S::commit(acquired, by, acquired.currentClaim, r.digest) }
}
pure def canElapse(r: Receipt, elapsed: Millis): bool = S::canElapse(r.session, elapsed)
pure def elapse(r: Receipt, elapsed: Millis): Receipt = { ...r, session: S::elapse(r.session, elapsed) }
pure def alwaysSessionIsSound(r: Receipt): bool = S::alwaysEffectHasCommittedOwner(r.session) and S::alwaysAtMostOneInvocation(r.session) and S::alwaysCompletedHasOutcome(r.session) and S::alwaysLiveClaimHasToken(r.session) and S::alwaysClaimSequenceIsValid(r.session) and S::alwaysAmbiguousCommitRemainsDurable(r.session)
pure def stepCommitNeverReopens(before: Receipt, after: Receipt): bool = S::stepCommitNeverReopens(before.session, after.session)
```

### The provider is asked at most once and answers only before the stale time, and only a clear reply settles the receipt

The send marker is the kernel's invocation. The shell's provider call ends
at the stale time; a reply after it is a lost reply. A reply showing the
requested effect settles `Succeeded`; a definite refusal settles `Refused`;
anything else leaves the receipt committed with an unknown outcome and no
sender still waiting. A process lost after the claim and before the send
leaves the receipt committed with no send marker.

```quint
type ProviderReply = ShowsEffect | DefiniteRefusal | Unclear
pure def settleWith(r: Receipt, verdict: Settlement): Receipt = { ...r, session: S::complete(S::recordOutcome(r.session)), settlement: verdict, settledAt: r.session.now }
pure def canSend(r: Receipt, by: S::SessionOwner): bool = r.settlement == Unsettled and r.session.now < staleAt(r) and S::canInvoke(r.session, by, r.session.currentClaim)
pure def send(r: Receipt, by: S::SessionOwner): Receipt = { ...r, session: S::invoke(r.session, by, r.session.currentClaim), sentAt: r.session.now }
pure def canReceiveReply(r: Receipt): bool = r.settlement == Unsettled and r.session.phase == S::Committed and r.session.effects == 1 and r.session.executorAlive and r.session.now < staleAt(r)
pure def receiveReply(r: Receipt, reply: ProviderReply): Receipt =
  if (reply == ShowsEffect) settleWith(r, Succeeded)
  else if (reply == DefiniteRefusal) settleWith(r, Refused)
  else { ...r, session: S::loseExecutor(r.session) }
pure def canLoseExecutor(r: Receipt): bool = r.settlement == Unsettled and S::canLoseExecutor(r.session)
pure def loseExecutor(r: Receipt): Receipt = { ...r, session: S::loseExecutor(r.session) }
pure def alwaysSentBeforeStale(r: Receipt): bool = r.session.effects == 1 implies r.sentAt < staleAt(r)
pure def sometimesSucceededOnReply(r: Receipt): bool = r.settlement == Succeeded and r.session.executorAlive
pure def sometimesRefusedOnReply(r: Receipt): bool = r.settlement == Refused and r.session.executorAlive
pure def sometimesUnknownAfterLostReply(r: Receipt): bool = r.settlement == Unsettled and r.session.effects == 1 and not(r.session.executorAlive)
pure def sometimesUnknownAfterLostSender(r: Receipt): bool = r.settlement == Unsettled and r.session.phase == S::Committed and r.session.effects == 0 and not(r.session.executorAlive)
```

### An unknown outcome is settled only by a provider lookup, and as not applied only after its stale time

The shell looks up by the receipt's provider key. A lookup that sees the
effect settles `Succeeded` and one that sees a refusal settles `Refused`;
both need the send marker. One that sees no effect settles `NotApplied`
only at or after the stale time, when no reply can still arrive. One that
cannot tell changes nothing, and the owner's sweep tries again.

```quint
type LookupResult = EffectSeen | RefusalSeen | NothingSeen | CannotTell
pure def canResolve(r: Receipt, lookup: LookupResult): bool =
  r.settlement == Unsettled and r.session.phase == S::Committed
  and (if (lookup == NothingSeen) r.session.now >= staleAt(r) else if (lookup == CannotTell) true else r.session.effects == 1)
pure def verdictOf(lookup: LookupResult): Settlement = if (lookup == EffectSeen) Succeeded else if (lookup == RefusalSeen) Refused else NotApplied
pure def resolve(r: Receipt, lookup: LookupResult): Receipt =
  if (lookup == CannotTell) r
  else if (r.session.effects == 1) settleWith(r, verdictOf(lookup))
  else { ...r, settlement: verdictOf(lookup), settledAt: r.session.now }
pure def sometimesLookupFindsTheEffect(r: Receipt): bool = r.settlement == Succeeded and not(r.session.executorAlive)
pure def sometimesNotAppliedBeforeAnySend(r: Receipt): bool = r.settlement == NotApplied and r.session.effects == 0
pure def sometimesNotAppliedAfterLostReply(r: Receipt): bool = r.settlement == NotApplied and r.session.effects == 1
```

### A settled receipt is final and agrees with its session

`Succeeded` and `Refused` were sent and completed the session. `NotApplied`
was settled at or after the stale time; it completed the session when a
send marker exists, and otherwise leaves it committed, where the kernel
keeps it and no send can follow.

```quint
pure def alwaysOutcomeFollowsTheSession(r: Receipt): bool =
  (r.settlement == Unsettled implies r.session.phase != S::Completed)
  and ((r.settlement == Succeeded or r.settlement == Refused) implies (r.session.phase == S::Completed and r.session.effects == 1))
  and (r.settlement == NotApplied implies (r.session.now >= staleAt(r) and ((r.session.phase == S::Completed and r.session.effects == 1) or (r.session.phase == S::Committed and r.session.effects == 0))))
pure def stepSettledIsFinal(before: Receipt, after: Receipt): bool =
  before.settlement != Unsettled implies (after.settlement == before.settlement and after.settledAt == before.settledAt and after.session.phase == before.session.phase and after.session.effects == before.session.effects)
```

### A receipt is dispatched exactly while it may still be sent or answered

A prepared receipt answers one status; an absent one has none, and the
shell answers `404 not_found`. A committed receipt is unknown once its
sender is lost or its stale time has passed. A rejected receipt carries why.

```quint
type ReceiptStatus = StatusPrepared | StatusDispatched | StatusUnknown | StatusSucceeded | StatusRejected
type RejectionCode = ProviderRefused | NotAppliedCode
pure def receiptStatus(r: Receipt): ReceiptStatus =
  if (r.settlement == Succeeded) StatusSucceeded
  else if (r.settlement != Unsettled) StatusRejected
  else if (r.session.phase != S::Committed) StatusPrepared
  else if (not(r.session.executorAlive) or r.session.now >= staleAt(r)) StatusUnknown
  else StatusDispatched
pure def rejectionCodeOf(r: Receipt): RejectionCode = if (r.settlement == NotApplied) NotAppliedCode else ProviderRefused
pure def alwaysDispatchedWhileTheProviderCanAnswer(r: Receipt): bool = receiptStatus(r) == StatusDispatched iff (canSend(r, r.session.owner) or canReceiveReply(r))
```

### A new receipt may follow only a rejected one, under a provider key the rejected one did not use

A rejection means the provider did not apply the change. An owner that tries
again tests `mayFollowWith` in the guard of its retry and prepares a new
receipt; it derives each provider key from the request and an attempt
number, so no two attempts share a key. Nothing else is ever sent again.

```quint
pure def mayFollowWith(old: Receipt, providerKey: ProviderKey): bool = (old.settlement == Refused or old.settlement == NotApplied) and providerKey != old.providerKey
pure def lawFollowUpOnlyAfterRejection(old: Receipt, providerKey: ProviderKey): bool = mayFollowWith(old, providerKey) implies receiptStatus(old) == StatusRejected
```

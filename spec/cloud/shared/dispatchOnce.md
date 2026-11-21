# Provider change dispatched once

One change the cloud makes at a provider (a checkout session, a subscription
update or schedule, a Gmail operation, a calendar write, a Google grant
revocation) is one `Receipt`, built on the kernel's once-only session
(`spec/core/sessions.md`). Owners embed a receipt in their own state and call
these transitions from theirs: `billing/checkout`,
`billing/subscriptionCommands`, `identity/deletion`,
`services/google/mailOperations` and `services/google/calendar`.

The session owner is `{agentId: organizationId, actorId: userId, connector}`,
where `connector` is the rendered kind of the provider key. The shell keys
receipts by organization, user and the owner's request key; an owner folds
any further scope into that key (mail uses `grantId:requestId`). It writes
each transition in one store transaction, persists the claim and the send
marker before any provider I/O, and never deletes a receipt row, so a
repeated request key always finds its receipt.

## Story: Send a change once and recover its outcome without sending it again

> As an account owner, I want each change the cloud makes at a provider for
> me sent at most once, and its outcome found again after a lost reply, so
> that I am never charged, cancelled or mailed twice.

### A receipt binds its owner, kind, request digest, provider key and stale duration once

Preparing creates the session. A second prepare with the same request key
finds this receipt: with the same owner and digest it answers the receipt as
it stands, in whatever state it has reached; another owner, kind or digest is
`409 idempotency_conflict` and leaves it unchanged.

```quint
import types.* from "./types"
import sessions as S from "../../core/sessions"
type Settlement = Unsettled | Succeeded | Refused | NotApplied
type RefusalCause = NoRefusal | NotFoundAtProvider | AuthorizationLost | OtherRefusal
type Receipt = { session: S::Session, digest: str, providerKey: ProviderKey, staleAfter: Millis, preparedAt: Millis, claimedAt: Millis, sentAt: Millis, settledAt: Millis, settlement: Settlement, refusal: RefusalCause }
pure val initial: Receipt = { session: S::initial, digest: "", providerKey: { providerKind: CheckoutSession, providerId: "" }, staleAfter: 0, preparedAt: 0, claimedAt: 0, sentAt: 0, settledAt: 0, settlement: Unsettled, refusal: NoRefusal }
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
pure def usesProviderKey(r: Receipt, key: ProviderKey): bool = kindOf(r) == key.providerKind and r.providerKey.providerId == key.providerId
pure def isConflict(r: Receipt, by: S::SessionOwner, digest: str): bool = r.session.phase != S::Absent and not(r.session.owner == by and r.digest == digest)
pure val conflictRefusal: Refusal = refuse(IdempotencyConflict)
pure def canPrepare(r: Receipt, by: S::SessionOwner, digest: str, providerKey: ProviderKey, staleAfter: Millis, expiresAt: Millis): bool =
  if (r.session.phase == S::Absent) S::canCreate(r.session, by, expiresAt) and digest != "" and providerKey.providerId != "" and by.connector == connectorOf(providerKey.providerKind) and staleAfter > 0
  else not(isConflict(r, by, digest))
pure def prepare(r: Receipt, by: S::SessionOwner, digest: str, providerKey: ProviderKey, staleAfter: Millis, expiresAt: Millis): Receipt =
  if (r.session.phase == S::Absent) { ...r, session: S::create(r.session, by, expiresAt), digest: digest, providerKey: { providerKind: providerKey.providerKind, providerId: providerKey.providerId }, staleAfter: staleAfter, preparedAt: r.session.now }
  else r
pure def alwaysPreparedIsBound(r: Receipt): bool =
  r.session.phase != S::Absent implies (r.session.owner.connector == connectorOf(kindOf(r)) and r.digest != "" and r.providerKey.providerId != "" and r.staleAfter > 0)
pure def stepBindingIsFixed(before: Receipt, after: Receipt): bool =
  before.session.phase != S::Absent implies (after.session.owner == before.session.owner and after.digest == before.digest and after.providerKey == before.providerKey and after.staleAfter == before.staleAfter and after.preparedAt == before.preparedAt)
```

### A prepared receipt that was never claimed may be abandoned as not applied

Nothing was sent, so its owner may settle it `NotApplied` at any time, for
example when the person never confirms or its session has expired.

```quint
pure def canAbandon(r: Receipt, by: S::SessionOwner): bool = r.settlement == Unsettled and r.session.phase == S::Pending and r.session.owner == by
pure def abandon(r: Receipt, by: S::SessionOwner): Receipt = { ...r, settlement: NotApplied, settledAt: r.session.now }
pure def sometimesAbandonedBeforeClaim(r: Receipt): bool = r.settlement == NotApplied and r.session.phase == S::Pending
```

### A receipt is claimed and committed before the provider is asked, and its stale time is fixed at the claim

The claim acquires the session with a lease of `staleAfter` and commits it
in one transaction, so a committed receipt is never claimable again. The
kernel's safety rules hold of every receipt; its cleanup and liveness rules
do not, and each owner's sweep settles unknown outcomes. On the wire
`dispatchedAt` is `claimedAt`.

```quint
pure def staleAt(r: Receipt): Millis = r.session.leaseUntil
pure def canClaim(r: Receipt, by: S::SessionOwner): bool = r.settlement == Unsettled and r.session.phase == S::Pending and S::canAcquire(r.session, by, r.digest, r.staleAfter)
pure def claim(r: Receipt, by: S::SessionOwner): Receipt = {
  val acquired = S::acquire(r.session, by, r.digest, r.staleAfter)
  { ...r, session: S::commit(acquired, by, acquired.currentClaim, r.digest), claimedAt: r.session.now }
}
pure def canElapse(r: Receipt, elapsed: Millis): bool = S::canElapse(r.session, elapsed)
pure def elapse(r: Receipt, elapsed: Millis): Receipt = { ...r, session: S::elapse(r.session, elapsed) }
pure def alwaysSessionIsSound(r: Receipt): bool = S::alwaysEffectHasCommittedOwner(r.session) and S::alwaysAtMostOneInvocation(r.session) and S::alwaysCompletedHasOutcome(r.session) and S::alwaysLiveClaimHasToken(r.session) and S::alwaysClaimSequenceIsValid(r.session) and S::alwaysAmbiguousCommitRemainsDurable(r.session)
pure def stepCommitNeverReopens(before: Receipt, after: Receipt): bool = S::stepCommitNeverReopens(before.session, after.session)
pure def stepStaleTimeIsFixed(before: Receipt, after: Receipt): bool =
  (before.session.phase == S::Committed or before.session.phase == S::Completed) implies (after.session.leaseUntil == before.session.leaseUntil and after.claimedAt == before.claimedAt)
```

### The provider is asked at most once, by the claim holder, and only before the stale time

The send marker is the kernel's invocation under the token the claim gave.
The shell's provider call ends at the stale time; a reply after it is lost.

```quint
pure val claimTokenValues = Set(0, 1, 2)
pure def canSend(r: Receipt, by: S::SessionOwner, claimToken: int): bool = r.settlement == Unsettled and r.session.now < staleAt(r) and S::canInvoke(r.session, by, claimToken)
pure def send(r: Receipt, by: S::SessionOwner, claimToken: int): Receipt = { ...r, session: S::invoke(r.session, by, claimToken), sentAt: r.session.now }
pure def alwaysSentBeforeStale(r: Receipt): bool = r.session.effects == 1 implies r.sentAt < staleAt(r)
```

### Only a clear reply settles a receipt; any other reply leaves its outcome unknown

A reply showing the requested effect settles `Succeeded`; a definite refusal
settles `Refused` with the provider's cause, which owners map (mail answers
`404 not_found` or `409 reauth_required`). Anything else, or a lost process,
leaves the receipt committed with no sender waiting.

```quint
type ProviderReply = ShowsEffect | DefiniteRefusal({ cause: RefusalCause }) | Unclear
pure val replyValues = Set(ShowsEffect, DefiniteRefusal({ cause: NotFoundAtProvider }), DefiniteRefusal({ cause: AuthorizationLost }), Unclear)
pure def settledAs(verdict: Settlement, cause: RefusalCause, r: Receipt): Receipt = { ...r, session: S::complete(S::recordOutcome(r.session)), settlement: verdict, refusal: cause, settledAt: r.session.now }
pure def canReceiveReply(r: Receipt, reply: ProviderReply): bool = r.settlement == Unsettled and r.session.phase == S::Committed and r.session.effects == 1 and r.session.executorAlive and r.session.now < staleAt(r) and reply != DefiniteRefusal({ cause: NoRefusal })
pure def receiveReply(r: Receipt, reply: ProviderReply): Receipt = match reply {
  | ShowsEffect => settledAs(Succeeded, NoRefusal, r)
  | DefiniteRefusal(refusal) => settledAs(Refused, refusal.cause, r)
  | Unclear => { ...r, session: S::loseExecutor(r.session) }
}
pure def canLoseExecutor(r: Receipt): bool = r.settlement == Unsettled and S::canLoseExecutor(r.session)
pure def loseExecutor(r: Receipt): Receipt = { ...r, session: S::loseExecutor(r.session) }
pure def sometimesSucceededOnReply(r: Receipt): bool = r.settlement == Succeeded and r.session.executorAlive
pure def sometimesRefusedOnReply(r: Receipt): bool = r.settlement == Refused and r.session.executorAlive
pure def sometimesUnknownAfterLostReply(r: Receipt): bool = r.settlement == Unsettled and r.session.effects == 1 and not(r.session.executorAlive)
pure def sometimesUnknownAfterLostSender(r: Receipt): bool = r.settlement == Unsettled and r.session.phase == S::Committed and r.session.effects == 0 and not(r.session.executorAlive)
```

### An unknown outcome is settled only by a provider lookup, and a sent one as not applied only after one more stale duration

The shell looks up by the receipt's provider key; when it cannot tell, it
does not step. Without a send marker nothing was sent, so the receipt settles
`NotApplied` without asking. After a send, a lookup that sees no effect
settles `NotApplied` only for a kind whose provider finds a change by its key
(not a Gmail operation, which stays unknown), and only one stale duration
after the stale time: each owner picks `staleAfter` at least as long as the
provider's own deadline for the call, so no request still in flight can land.

```quint
type LookupResult = EffectSeen | RefusalSeen({ cause: RefusalCause }) | NothingSeen
pure val lookupValues = Set(EffectSeen, RefusalSeen({ cause: AuthorizationLost }), NothingSeen)
pure def lookupFindsAbsence(kind: ProviderKind): bool = kind != GmailOperation
pure def isUnknown(r: Receipt): bool = r.settlement == Unsettled and r.session.phase == S::Committed and (not(r.session.executorAlive) or r.session.now >= staleAt(r))
pure def canResolve(r: Receipt, lookup: LookupResult): bool = isUnknown(r) and (match lookup {
  | EffectSeen => r.session.effects == 1
  | RefusalSeen(refusal) => r.session.effects == 1 and refusal.cause != NoRefusal
  | NothingSeen => r.session.effects == 0 or (lookupFindsAbsence(kindOf(r)) and r.session.now >= staleAt(r) + r.staleAfter)
})
pure def resolve(r: Receipt, lookup: LookupResult): Receipt = match lookup {
  | EffectSeen => settledAs(Succeeded, NoRefusal, r)
  | RefusalSeen(refusal) => settledAs(Refused, refusal.cause, r)
  | NothingSeen => if (r.session.effects == 1) settledAs(NotApplied, NoRefusal, r) else { ...r, settlement: NotApplied, settledAt: r.session.now }
}
pure def stepUnknownSettlesOnlyByLookup(before: Receipt, via: str, after: Receipt): bool = (isUnknown(before) and after.settlement != Unsettled) implies via == "resolve"
pure def sometimesLookupFindsTheEffect(r: Receipt): bool = r.settlement == Succeeded and not(r.session.executorAlive)
pure def sometimesLookupFindsARefusal(r: Receipt): bool = r.settlement == Refused and not(r.session.executorAlive)
pure def sometimesNotAppliedBeforeAnySend(r: Receipt): bool = r.settlement == NotApplied and r.session.phase == S::Committed and r.session.effects == 0
pure def sometimesNotAppliedAfterSend(r: Receipt): bool = r.settlement == NotApplied and r.session.effects == 1
```

### A settled receipt is final and agrees with its session

`Succeeded` and `Refused` were sent and completed the session, and only
`Refused` carries a cause. `NotApplied` either has no send marker and leaves
the session pending or committed, where no send can follow, or was sent,
completed the session and was settled one stale duration after its stale
time.

```quint
pure def alwaysOutcomeFollowsTheSession(r: Receipt): bool =
  (r.settlement == Unsettled implies r.session.phase != S::Completed)
  and ((r.settlement == Succeeded or r.settlement == Refused) implies (r.session.phase == S::Completed and r.session.effects == 1))
  and (r.settlement == NotApplied implies ((r.session.effects == 0 and r.session.phase != S::Completed) or (r.session.phase == S::Completed and r.session.effects == 1 and r.session.now >= staleAt(r) + r.staleAfter)))
  and ((r.settlement == Refused) iff (r.refusal != NoRefusal))
pure def stepSettledIsFinal(before: Receipt, after: Receipt): bool =
  before.settlement != Unsettled implies (after.settlement == before.settlement and after.refusal == before.refusal and after.settledAt == before.settledAt and after.session.phase == before.session.phase and after.session.effects == before.session.effects)
```

### A receipt's status is read from its settlement, its session and the stale time

An absent receipt answers `404 not_found`. A committed receipt is unknown
once its sender is lost or its stale time has passed.

```quint
type ReceiptStatus = StatusAbsent | StatusPrepared | StatusDispatched | StatusUnknown | StatusSucceeded | StatusRejected
pure def receiptStatus(r: Receipt): ReceiptStatus =
  if (r.session.phase == S::Absent) StatusAbsent
  else if (r.settlement == Succeeded) StatusSucceeded
  else if (r.settlement != Unsettled) StatusRejected
  else if (r.session.phase == S::Pending) StatusPrepared
  else if (isUnknown(r)) StatusUnknown
  else StatusDispatched
```

### A new receipt may follow only a rejected one, under a different provider key

A rejection means the provider did not apply the change. An owner that tries
again tests `mayFollowWith` in the guard of its retry and prepares a new
receipt; it derives each provider key from the request and an attempt number,
so no two attempts share a key. Nothing else is ever sent again.

```quint
pure def mayFollowWith(old: Receipt, providerKey: ProviderKey): bool = (old.settlement == Refused or old.settlement == NotApplied) and not(usesProviderKey(old, providerKey))
```

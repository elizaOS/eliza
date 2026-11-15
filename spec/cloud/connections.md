# Provider connections

A user connects a provider account to their organization through an
authorization intent: the cloud records the intent, a decision on it and the
event that announces the decision in one transaction, and accepts a decision
only while the intent is open and within its lifetime. A connection becomes
active only through the callback that answers the exact authorization the
organization started. One intent and one provider connection are the state
machine. Proof verification of the provider's reply and delivery of the
callback to a client are separate protocols.

Develop sources: the cloud `authorization_intents` model, for both
authorization intents and approval requests, and the provider-connection
routes of the cloud API, which develop did not model.

## Story: Decide an authorization once, within its lifetime

> As a user granting or refusing access, I want my decision recorded once,
> with its event, and never overwritten by a later or a foreign one.

### An intent and its lifecycle events commit together

Creating an intent writes it with its creation event or not at all. Every
accepted decision appends exactly its event, so the events of an intent are
always its creation, its delivery if it was delivered, and its terminal
decision if it has one.

```quint
type IntentKind = OAuthIntent | ApprovalIntent
type IntentStatus = IntentAbsent | IntentPending | IntentDelivered | IntentApproved | IntentBound | IntentDenied | IntentCanceled | IntentExpired
type AttemptPhase = AttemptNew | AttemptWaiting | AttemptDone
type IntentAttempt = { caller: int, phase: AttemptPhase, target: IntentStatus, tenant: int, startedAt: int, signed: bool }
type ConnectionPhase = NotConnected | Authorizing | ConnectionActive | NeedsReauthorization | ConnectionRevoked
type Authorization = {
  kind: IntentKind, status: IntentStatus, clock: int, events: List[IntentStatus], delivered: bool, signature: bool, decided: IntentStatus, decidedAt: int, cancelTenant: int, attempts: List[IntentAttempt],
  connection: ConnectionPhase, pendingState: int, consumedStates: Set[int], connectionOrg: int, activations: int
}
pure val intentLifetime = 2
pure def newAttempt(caller: int): IntentAttempt = { caller: caller, phase: AttemptNew, target: IntentDenied, tenant: 1, startedAt: 0, signed: false }
pure val initial: Authorization = {
  kind: OAuthIntent, status: IntentAbsent, clock: 0, events: List(), delivered: false, signature: false, decided: IntentAbsent, decidedAt: -1, cancelTenant: 0, attempts: List(newAttempt(1), newAttempt(2)),
  connection: NotConnected, pendingState: 0, consumedStates: Set(), connectionOrg: 0, activations: 0
}
pure def terminalStatus(status: IntentStatus): bool = status == IntentApproved or status == IntentBound or status == IntentDenied or status == IntentCanceled or status == IntentExpired
pure def canCreateIntent(a: Authorization, kind: IntentKind): bool = a.status == IntentAbsent
pure def createIntent(a: Authorization, kind: IntentKind): Authorization = { ...a, kind: kind, status: IntentPending, events: List(IntentPending) }
pure def canTickClock(a: Authorization): bool = a.status != IntentAbsent
pure def tickClock(a: Authorization): Authorization = { ...a, clock: a.clock + 1 }
pure def expectedEvents(a: Authorization): List[IntentStatus] =
  if (a.status == IntentAbsent) List()
  else {
    val opened = if (a.delivered) List(IntentPending, IntentDelivered) else List(IntentPending)
    if (terminalStatus(a.status)) opened.append(a.status) else opened
  }
pure def alwaysEventsMatchTheIntent(a: Authorization): bool = a.events == expectedEvents(a)
pure def alwaysOnlyApprovalsAreDelivered(a: Authorization): bool = a.delivered implies a.kind == ApprovalIntent
```

### A decision is accepted only while the intent is open and current

Callers prepare a decision and commit it later. A commit is accepted only if
the intent is still pending or delivered and the decision is made before the
intent's lifetime of two clock ticks ends; an approval may be delivered only
while pending, and only the owning tenant may cancel. Only the expiry sweep
may expire an intent, and only with a cutoff it read after the lifetime
ended. A refused or failed commit changes nothing, a decided intent keeps its
decision, and only an approval carries a signature.

```quint
pure def successStatus(kind: IntentKind): IntentStatus = if (kind == ApprovalIntent) IntentApproved else IntentBound
pure def decisionTarget(kind: IntentKind, target: IntentStatus): bool =
  target == successStatus(kind) or target == IntentDenied or target == IntentCanceled or target == IntentExpired or (kind == ApprovalIntent and target == IntentDelivered)
pure def intentOpen(a: Authorization): bool = a.status == IntentPending or a.status == IntentDelivered
pure def attemptOf(a: Authorization, caller: int): IntentAttempt = a.attempts.select(t => t.caller == caller).nthOr(0, newAttempt(0))
pure def withAttempt(a: Authorization, attempt: IntentAttempt): List[IntentAttempt] = a.attempts.listMap(t => if (t.caller == attempt.caller) attempt else t)
pure def admitted(a: Authorization, attempt: IntentAttempt): bool =
  if (attempt.target == IntentExpired) intentOpen(a) and attempt.startedAt >= intentLifetime
  else intentOpen(a) and a.clock < intentLifetime and (attempt.target != IntentDelivered or (a.kind == ApprovalIntent and a.status == IntentPending)) and (attempt.target != IntentCanceled or attempt.tenant == 1)
pure def canPrepareDecision(a: Authorization, caller: int, target: IntentStatus, tenant: int, signed: bool): bool =
  a.status != IntentAbsent and attemptOf(a, caller).phase == AttemptNew and attemptOf(a, caller).caller == caller and decisionTarget(a.kind, target) and (signed implies target == IntentApproved)
pure def prepareDecision(a: Authorization, caller: int, target: IntentStatus, tenant: int, signed: bool): Authorization =
  { ...a, attempts: withAttempt(a, { caller: caller, phase: AttemptWaiting, target: target, tenant: tenant, startedAt: a.clock, signed: signed }) }
pure def canCommitDecision(a: Authorization, caller: int): bool = attemptOf(a, caller).phase == AttemptWaiting and attemptOf(a, caller).caller == caller
pure def commitDecision(a: Authorization, caller: int): Authorization = {
  val attempt = attemptOf(a, caller)
  val finished = withAttempt(a, { ...attempt, phase: AttemptDone })
  if (admitted(a, attempt)) {
    ...a, status: attempt.target, events: a.events.append(attempt.target), delivered: a.delivered or attempt.target == IntentDelivered,
    signature: a.signature or attempt.signed, decided: if (terminalStatus(attempt.target)) attempt.target else a.decided,
    decidedAt: if (terminalStatus(attempt.target)) a.clock else a.decidedAt, cancelTenant: if (attempt.target == IntentCanceled) attempt.tenant else a.cancelTenant, attempts: finished
  } else { ...a, attempts: finished }
}
pure def canStorageFailure(a: Authorization, caller: int): bool = attemptOf(a, caller).phase == AttemptWaiting and attemptOf(a, caller).caller == caller
pure def storageFailure(a: Authorization, caller: int): Authorization = { ...a, attempts: withAttempt(a, { ...attemptOf(a, caller), phase: AttemptDone }) }
pure val callerValues = Set(1, 2)
pure val tenantValues = Set(1, 2)
pure def alwaysDecisionIsStable(a: Authorization): bool = a.decided == IntentAbsent or a.status == a.decided
pure def alwaysAcceptedWithinLifetime(a: Authorization): bool = (a.status == IntentApproved or a.status == IntentBound) implies (a.decidedAt >= 0 and a.decidedAt < intentLifetime)
pure def alwaysCancelledByTheOwningTenant(a: Authorization): bool = a.status == IntentCanceled implies a.cancelTenant == 1
pure def alwaysSignatureOnlyOnApproval(a: Authorization): bool = a.signature implies a.status == IntentApproved
pure def sometimesApprovalDeliveredThenApproved(a: Authorization): bool = a.status == IntentApproved and a.delivered
pure def sometimesLateDecisionRefused(a: Authorization): bool = a.status == IntentPending and a.clock >= intentLifetime and a.attempts.select(t => t.phase == AttemptDone).length() > 0
pure def sometimesIntentExpired(a: Authorization): bool = a.status == IntentExpired
pure val weight_prepareDecision = 3
pure val weight_commitDecision = 3
```

## Story: Connect a provider account to my organization

> As a user, I want a provider account connected only by the authorization I
> started, for my organization, and disconnected for good when I revoke it.

### A connection activates only through the exact pending authorization

Starting an authorization records a fresh state value for the organization;
a state value is never reused. The provider's callback activates the
connection only if it carries that exact pending state for the same
organization, and consumes it. A failed token refresh asks the user to
authorize again rather than staying active; revoking ends the connection
until the user authorizes again.

```quint
pure def canBeginAuthorization(a: Authorization, stateNonce: int, org: int): bool =
  a.connection != Authorizing and a.connection != ConnectionActive and stateNonce > 0 and org > 0 and not(a.consumedStates.contains(stateNonce))
pure def beginAuthorization(a: Authorization, stateNonce: int, org: int): Authorization = { ...a, connection: Authorizing, pendingState: stateNonce, connectionOrg: org }
pure def canCompleteCallback(a: Authorization, stateNonce: int, org: int): bool =
  a.connection == Authorizing and stateNonce == a.pendingState and org == a.connectionOrg and not(a.consumedStates.contains(stateNonce))
pure def completeCallback(a: Authorization, stateNonce: int, org: int): Authorization =
  { ...a, connection: ConnectionActive, consumedStates: a.consumedStates.union(Set(stateNonce)), pendingState: 0, activations: a.activations + 1 }
pure def canRefreshFailed(a: Authorization): bool = a.connection == ConnectionActive
pure def refreshFailed(a: Authorization): Authorization = { ...a, connection: NeedsReauthorization }
pure def canRevokeConnection(a: Authorization): bool = a.connection == ConnectionActive or a.connection == NeedsReauthorization or a.connection == Authorizing
pure def revokeConnection(a: Authorization): Authorization = { ...a, connection: ConnectionRevoked, pendingState: 0 }
pure val stateNonceValues = Set(1, 2, 3)
pure val orgValues = Set(1, 2)
pure def alwaysPendingStateIsUnused(a: Authorization): bool = (a.connection == Authorizing implies (a.pendingState > 0 and not(a.consumedStates.contains(a.pendingState)))) and (a.connection != Authorizing implies a.pendingState == 0)
pure def alwaysEachActivationConsumedAState(a: Authorization): bool = a.activations == a.consumedStates.size() and (a.connection == ConnectionActive implies a.activations > 0)
pure def stepActivationOnlyByCallback(before: Authorization, via: str, after: Authorization): bool =
  (before.connection != ConnectionActive and after.connection == ConnectionActive) implies (via == "completeCallback" and before.connection == Authorizing)
pure def stepConsumedStatesStayConsumed(before: Authorization, after: Authorization): bool = before.consumedStates.subseteq(after.consumedStates)
pure def sometimesReconnectedAfterRevocation(a: Authorization): bool = a.connection == ConnectionActive and a.activations == 2
pure def sometimesRefreshNeedsReauthorization(a: Authorization): bool = a.connection == NeedsReauthorization
```

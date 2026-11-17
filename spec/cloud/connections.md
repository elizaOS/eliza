# Provider connections

A user connects a provider account to their organization through an
authorization intent: the cloud records the intent, a decision on it and the
event that announces the decision in one transaction, and accepts a decision
only while the intent is open and within its lifetime. A connection becomes
active only through the callback that answers the exact authorization the
organization started, or through a one-time code a native sign-in carries
from the same Google account. One intent and one provider connection are the
state machine. The cloud reports the connection to its owner as one status
projection. Proof verification of the provider's reply and delivery of the
callback to a client are separate protocols; the native sign-in exchange that
carries the code is [native clients](./nativeClients.md).

## Story: Decide an authorization once, within its lifetime

> As a user granting or refusing access, I want my decision recorded once,
> with its event, and never overwritten by a later or a foreign one.

### An intent and its lifecycle events commit together

Creating an intent writes it with its creation event or not at all. Every
accepted decision appends exactly its event, so the events of an intent are
always its creation, its delivery if it was delivered, and its terminal
decision if it has one. Only an approval intent is delivered, and only after
it left pending.

```quint
type IntentKind = OAuthIntent | ApprovalIntent
type IntentStatus = IntentAbsent | IntentPending | IntentDelivered | IntentApproved | IntentBound | IntentDenied | IntentCanceled | IntentExpired
type AttemptPhase = AttemptNew | AttemptWaiting | AttemptDone
type IntentAttempt = { caller: int, phase: AttemptPhase, target: IntentStatus, tenant: int, startedAt: int, signed: bool }
type ConnectionPhase = NotConnected | Authorizing | ConnectionActive | NeedsReauthorization | ConnectionRevoked
type NativeLinkOutcome = NativeNotTried | NativeLinked | GoogleNotConfigured | GoogleAccountUnknown | OwnerRequired | GoogleAccountMismatch | GoogleScopesMissing | GoogleCodeRejected | GoogleUnavailable
type Authorization = {
  kind: IntentKind, status: IntentStatus, clock: int, events: List[IntentStatus], delivered: bool, signature: bool, decided: IntentStatus, decidedAt: int, cancelTenant: int, attempts: List[IntentAttempt],
  connection: ConnectionPhase, pendingState: int, consumedStates: Set[int], connectionOrg: int, activations: int, consumedCodes: Set[int], nativeOutcome: NativeLinkOutcome
}
pure val intentLifetime = 2
pure def newAttempt(caller: int): IntentAttempt = { caller: caller, phase: AttemptNew, target: IntentDenied, tenant: 1, startedAt: 0, signed: false }
pure val initial: Authorization = {
  kind: OAuthIntent, status: IntentAbsent, clock: 0, events: List(), delivered: false, signature: false, decided: IntentAbsent, decidedAt: -1, cancelTenant: 0, attempts: List(newAttempt(1), newAttempt(2)),
  connection: NotConnected, pendingState: 0, consumedStates: Set(), connectionOrg: 0, activations: 0, consumedCodes: Set(), nativeOutcome: NativeNotTried
}
pure def terminalStatus(status: IntentStatus): bool = status == IntentApproved or status == IntentBound or status == IntentDenied or status == IntentCanceled or status == IntentExpired
pure def canCreateIntent(a: Authorization, kind: IntentKind): bool = a.status == IntentAbsent
pure def createIntent(a: Authorization, kind: IntentKind): Authorization = { ...a, kind: kind, status: IntentPending, events: List(IntentPending) }
pure def canTickClock(a: Authorization): bool = a.status != IntentAbsent
pure def tickClock(a: Authorization): Authorization = { ...a, clock: a.clock + 1 }
pure def openedEvents(a: Authorization): List[IntentStatus] = if (a.delivered) List(IntentPending, IntentDelivered) else List(IntentPending)
pure def expectedEvents(a: Authorization): List[IntentStatus] =
  if (a.status == IntentAbsent) List()
  else if (terminalStatus(a.status)) openedEvents(a).append(a.status)
  else openedEvents(a)
pure def alwaysEventsMatchTheIntent(a: Authorization): bool = a.events == expectedEvents(a)
pure def alwaysOnlyApprovalsAreDelivered(a: Authorization): bool =
  a.delivered implies (a.kind == ApprovalIntent and a.status != IntentAbsent and a.status != IntentPending)
```

### A decision is accepted only while the intent is open and current

Callers prepare a decision and commit it later. A commit is accepted only if
the intent is still pending or delivered and the decision is made before the
intent's lifetime of two clock ticks ends; an approval may be delivered only
while pending, and only the owning tenant may cancel. Only the expiry sweep
may expire an intent, and only with a cutoff it read after the lifetime
ended. A refused or failed commit changes nothing, a decided intent keeps its
terminal decision, and only an approval carries a signature.

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
pure def alwaysDecisionIsStable(a: Authorization): bool = a.decided == IntentAbsent or (a.status == a.decided and terminalStatus(a.decided))
pure def alwaysAcceptedWithinLifetime(a: Authorization): bool = (a.status == IntentApproved or a.status == IntentBound) implies (a.decidedAt >= 0 and a.decidedAt < intentLifetime)
pure def alwaysCancelledByTheOwningTenant(a: Authorization): bool = a.status == IntentCanceled implies a.cancelTenant == 1
pure def alwaysSignatureOnlyOnApproval(a: Authorization): bool = a.signature implies a.status == IntentApproved
pure def sometimesApprovalDeliveredThenApproved(a: Authorization): bool = a.status == IntentApproved and a.delivered
pure def sometimesLateDecisionRefused(a: Authorization): bool = a.status == IntentPending and a.clock >= intentLifetime and a.attempts.select(t => t.phase == AttemptDone).length() > 0
pure def sometimesIntentExpired(a: Authorization): bool = a.status == IntentExpired
pure val weight_prepareDecision = 3
pure val weight_commitDecision = 3
```

### A prepared decision is a delivery or a terminal decision, and only a prepared approval is signed

```quint
pure def alwaysPreparedDecisionsAreDecisions(a: Authorization): bool =
  a.attempts.every(t => (t.target == IntentDelivered or terminalStatus(t.target)) and (t.signed implies t.target == IntentApproved))
```

### The intent's clock counts up from zero

```quint
pure def alwaysClockCountsUpFromZero(a: Authorization): bool = a.clock >= 0
```

## Story: Connect a provider account to my organization

> As a user, I want a provider account connected only by the authorization I
> started, for my organization, and disconnected for good when I revoke it.

### A connection activates only through the exact pending authorization or a one-time native code

Starting an authorization records a fresh state value for the organization;
a state value is never reused. The provider's callback activates the
connection only if it carries that exact pending state for the same
organization, and consumes it. The only other way a connection activates is
a native sign-in's one-time code (the next rule), which is consumed the same
way. Every activation therefore consumed exactly one state value or one
code. A failed token refresh asks the user to authorize again rather than
staying active; revoking ends the connection until the user authorizes
again.

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
pure def alwaysEachActivationConsumedAStateOrCode(a: Authorization): bool = a.activations == a.consumedStates.size() + a.consumedCodes.size() and (a.connection == ConnectionActive implies a.activations > 0)
pure def stepActivationOnlyByCallbackOrNativeCode(before: Authorization, via: str, after: Authorization): bool =
  (before.connection != ConnectionActive and after.connection == ConnectionActive) implies
    ((via == "completeCallback" and before.connection == Authorizing) or (via == "linkNativeCode" and after.nativeOutcome == NativeLinked))
pure def stepConsumedStatesStayConsumed(before: Authorization, after: Authorization): bool = before.consumedStates.subseteq(after.consumedStates)
pure def sometimesReconnectedAfterRevocation(a: Authorization): bool = a.connection == ConnectionActive and a.activations == 2
pure def sometimesRefreshNeedsReauthorization(a: Authorization): bool = a.connection == NeedsReauthorization
```

### A native sign-in links the Google account in the same exchange, only with a one-time code from that account

A native sign-in may carry a one-time server code that grants the cloud
mail and calendar access. The cloud tries the link only after the sign-in
itself succeeded, and the link's outcome never fails the sign-in: the reply
carries either the linked connection or a code saying why not, and the owner
can link again later with a fresh code. The link is refused, changing
nothing, when Google is not configured on the cloud, when the verified
sign-in names no Google account, when the signed-in user does not own the
organization, when Google refuses the code (a code already used is
refused), when Google is unavailable, when Google reports no granted
scopes, and when Google says the code belongs to another account than the
one that signed in, checked in that order. A linked code activates the connection
for the organization exactly as a callback does, ends any browser
authorization still pending, and is consumed for good. A native code never
activates an already active connection.

```quint
type GoogleExchange = ExchangeAccepted | ExchangeOtherAccount | ExchangeNoScopes | ExchangeCodeRefused | ExchangeUnavailable
type NativeLinkFacts = { googleConfigured: bool, subjectKnown: bool, ownerCaller: bool, exchange: GoogleExchange }
pure def nativeLinkOutcome(a: Authorization, code: int, facts: NativeLinkFacts): NativeLinkOutcome =
  if (not(facts.googleConfigured)) GoogleNotConfigured
  else if (not(facts.subjectKnown)) GoogleAccountUnknown
  else if (not(facts.ownerCaller)) OwnerRequired
  else if (facts.exchange == ExchangeCodeRefused or a.consumedCodes.contains(code)) GoogleCodeRejected
  else if (facts.exchange == ExchangeUnavailable) GoogleUnavailable
  else if (facts.exchange == ExchangeNoScopes) GoogleScopesMissing
  else if (facts.exchange == ExchangeOtherAccount) GoogleAccountMismatch
  else NativeLinked
pure def canLinkNativeCode(a: Authorization, code: int, org: int, facts: NativeLinkFacts): bool =
  code > 0 and org > 0 and a.connection != ConnectionActive
pure def linkNativeCode(a: Authorization, code: int, org: int, facts: NativeLinkFacts): Authorization =
  if (nativeLinkOutcome(a, code, facts) == NativeLinked)
    { ...a, connection: ConnectionActive, pendingState: 0, connectionOrg: org, consumedCodes: a.consumedCodes.union(Set(code)), activations: a.activations + 1, nativeOutcome: NativeLinked }
  else { ...a, nativeOutcome: nativeLinkOutcome(a, code, facts) }
pure val codeValues = Set(1, 2)
pure val factsValues = Set(
  { googleConfigured: true, subjectKnown: true, ownerCaller: true, exchange: ExchangeAccepted },
  { googleConfigured: true, subjectKnown: true, ownerCaller: true, exchange: ExchangeOtherAccount },
  { googleConfigured: true, subjectKnown: true, ownerCaller: false, exchange: ExchangeAccepted },
  { googleConfigured: false, subjectKnown: true, ownerCaller: true, exchange: ExchangeAccepted },
  { googleConfigured: true, subjectKnown: true, ownerCaller: true, exchange: ExchangeUnavailable })
pure def lawNativeLinkNeedsTheSameOwnerAccount(a: Authorization, code: int, facts: NativeLinkFacts): bool =
  nativeLinkOutcome(a, code, facts) == NativeLinked implies
    (facts.googleConfigured and facts.subjectKnown and facts.ownerCaller and facts.exchange == ExchangeAccepted and not(a.consumedCodes.contains(code)))
pure def stepNativeCodesStayConsumed(before: Authorization, after: Authorization): bool = before.consumedCodes.subseteq(after.consumedCodes)
pure def stepRefusedNativeLinkChangesNoConnection(before: Authorization, via: str, after: Authorization): bool =
  (via == "linkNativeCode" and after.nativeOutcome != NativeLinked) implies
    (after.connection == before.connection and after.activations == before.activations and after.pendingState == before.pendingState)
pure def sometimesLinkedByNativeCode(a: Authorization): bool = a.connection == ConnectionActive and a.consumedCodes.size() > 0
pure def sometimesNativeLinkRefusedForAnotherAccount(a: Authorization): bool = a.nativeOutcome == GoogleAccountMismatch
pure def sometimesUsedNativeCodeRefused(a: Authorization): bool = a.nativeOutcome == GoogleCodeRejected and a.consumedCodes.size() > 0
```

## Story: See my Google connection as the cloud holds it

> As an owner, I want one status that says whether my Google account is
> connected, why not if it is not, and exactly what it lets my agent do.

### The status names the connection's grant and derives its capabilities from the granted scopes alone

The owner's status reports the cloud-managed mode for the side it was asked
about. When Google is not configured on the cloud the status is
`config_missing` and names nothing else. With no connection it is
`disconnected`, with no identity, grant, scopes, capabilities or refresh
token. Otherwise it describes the connection asked for by grant, or the
active one, or else the latest one: its connection ID is that grant's ID,
it carries the account identity and the scopes Google granted, and it says
whether a refresh token is stored. A grant ID is never zero, so a status
without one names no identity, scopes, refresh token or connection. It is connected only while the
connection is active; a connection that needs the owner to authorize again
reports `needs_reauth`, and any other reports `disconnected`. A grant asked
for by ID that the owner does not hold is not found. The capabilities are
computed from the granted scopes and nothing else: identity from any
identity scope; calendar read from the read-only, events or full calendar
scope; calendar write from the events or full calendar scope; mail triage
from the metadata, read-only, modify or compose scope; drafts from compose
or modify; mailbox changes from modify; send from send; and mail management
from modify together with basic settings.

```quint
type GrantedScopes = { identity: bool, calendarReadOnly: bool, calendarEvents: bool, calendarFull: bool, gmailMetadata: bool, gmailReadOnly: bool, gmailModify: bool, gmailCompose: bool, gmailSend: bool, gmailSettings: bool }
type GoogleCapabilities = { basicIdentity: bool, calendarRead: bool, calendarWrite: bool, gmailTriage: bool, gmailDrafts: bool, gmailMailbox: bool, gmailSend: bool, gmailManage: bool }
type StatusReason = ReasonConnected | ReasonDisconnected | ReasonConfigMissing | ReasonNeedsReauth | ReasonNotFound
type StatusConnection = { present: bool, grant: int, phase: ConnectionPhase, scopes: GrantedScopes, refreshStored: bool }
type GoogleStatus = { configured: bool, connected: bool, reason: StatusReason, identityShown: bool, connectionId: int, capabilities: GoogleCapabilities, scopesShown: bool, hasRefreshToken: bool }
pure val noScopes: GrantedScopes = { identity: false, calendarReadOnly: false, calendarEvents: false, calendarFull: false, gmailMetadata: false, gmailReadOnly: false, gmailModify: false, gmailCompose: false, gmailSend: false, gmailSettings: false }
pure def capabilitiesOf(g: GrantedScopes): GoogleCapabilities = {
  basicIdentity: g.identity,
  calendarRead: g.calendarReadOnly or g.calendarEvents or g.calendarFull,
  calendarWrite: g.calendarEvents or g.calendarFull,
  gmailTriage: g.gmailMetadata or g.gmailReadOnly or g.gmailModify or g.gmailCompose,
  gmailDrafts: g.gmailCompose or g.gmailModify,
  gmailMailbox: g.gmailModify,
  gmailSend: g.gmailSend,
  gmailManage: g.gmailModify and g.gmailSettings
}
pure def emptyStatus(configured: bool, reason: StatusReason): GoogleStatus =
  { configured: configured, connected: false, reason: reason, identityShown: false, connectionId: 0, capabilities: capabilitiesOf(noScopes), scopesShown: false, hasRefreshToken: false }
pure def googleStatus(configured: bool, askedGrant: int, held: StatusConnection): GoogleStatus =
  if (not(configured)) emptyStatus(false, ReasonConfigMissing)
  else if (askedGrant > 0 and not(held.present and held.grant == askedGrant)) emptyStatus(true, ReasonNotFound)
  else if (not(held.present)) emptyStatus(true, ReasonDisconnected)
  else {
    configured: true, connected: held.phase == ConnectionActive,
    reason: if (held.phase == ConnectionActive) ReasonConnected else if (held.phase == NeedsReauthorization) ReasonNeedsReauth else ReasonDisconnected,
    identityShown: true, connectionId: held.grant, capabilities: capabilitiesOf(held.scopes), scopesShown: true, hasRefreshToken: held.refreshStored
  }
pure val heldValues = Set(
  { present: false, grant: 0, phase: NotConnected, scopes: noScopes, refreshStored: false },
  { present: true, grant: 7, phase: ConnectionActive, scopes: { ...noScopes, identity: true, calendarEvents: true, gmailModify: true, gmailSend: true }, refreshStored: true },
  { present: true, grant: 7, phase: NeedsReauthorization, scopes: { ...noScopes, gmailReadOnly: true }, refreshStored: false },
  { present: true, grant: 8, phase: ConnectionRevoked, scopes: { ...noScopes, calendarReadOnly: true, gmailModify: true, gmailSettings: true }, refreshStored: true })
pure val askedGrantValues = Set(0, 7, 9)
pure val gValues = Set(noScopes, { ...noScopes, calendarEvents: true }, { ...noScopes, gmailModify: true }, { ...noScopes, gmailCompose: true, gmailSettings: true }, { ...noScopes, gmailModify: true, gmailSettings: true, calendarFull: true })
pure def lawConnectedOnlyWhileActive(configured: bool, askedGrant: int, held: StatusConnection): bool = {
  val st = googleStatus(configured, askedGrant, held)
  (st.connected iff (configured and held.present and held.phase == ConnectionActive and (askedGrant <= 0 or askedGrant == held.grant))) and
  (st.connected iff st.reason == ReasonConnected)
}
pure def lawStatusNamesTheHeldGrant(configured: bool, askedGrant: int, held: StatusConnection): bool = {
  val st = googleStatus(configured, askedGrant, held)
  (held.present implies held.grant > 0) implies
    ((st.connectionId != 0 implies (held.present and st.connectionId == held.grant and (askedGrant <= 0 or askedGrant == held.grant))) and
     (st.connectionId == 0 implies not(st.identityShown or st.scopesShown or st.hasRefreshToken or st.connected)))
}
pure def lawUnconfiguredNamesNothing(askedGrant: int, held: StatusConnection): bool =
  googleStatus(false, askedGrant, held) == emptyStatus(false, ReasonConfigMissing)
pure def lawCapabilitiesComeOnlyFromScopes(configured: bool, askedGrant: int, held: StatusConnection): bool = {
  val st = googleStatus(configured, askedGrant, held)
  st.capabilities == (if (st.scopesShown) capabilitiesOf(held.scopes) else capabilitiesOf(noScopes))
}
pure def lawWriteAndManageImplyTheirReads(g: GrantedScopes): bool = {
  val c = capabilitiesOf(g)
  (c.calendarWrite implies c.calendarRead) and (c.gmailManage implies c.gmailMailbox) and (c.gmailMailbox implies c.gmailTriage and c.gmailDrafts)
}
```

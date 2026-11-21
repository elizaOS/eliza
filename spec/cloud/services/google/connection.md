# Managed Google connection

The owner's Google grant, held by the cloud. Sources: develop
`agent-google-connector/shared.ts`, `oauth/{oauth2.ts,token-cache.ts}`,
`api/v1/oauth/app-oauth-return.ts`. Routes under `/api/v1/eliza/google/` (device
key or session): `POST connect/initiate {side, capabilities, redirectUrl?}`,
`POST connect/native {serverAuthCode}`, `GET status`, `GET accounts` (every
connection's status), `POST disconnect {side, connectionId?}`; Google calls
`GET /api/v1/oauth/google/callback`. One instance is one connection row; the
shell seals tokens (purpose `GoogleTokens`), keeps identity, `linkedAt` and
`lastUsedAt`, and deletes rows left `Pending`. A unique index keeps one
connection per (organization, Google subject).

## Story: Connect my Google account with the access I chose

> As an owner, I want to connect my Google account with exactly the access I
> chose and come back to the app that sent me, so that my assistant can use
> my mail and calendar only as far as I allowed.

### Each capability asks for its scopes from one table, and a grant's capabilities come from its granted scopes alone

`google.basic_identity` is always asked for. Calendar read and write ask for
`calendar.events`, triage `gmail.readonly`, drafts `gmail.compose`, mailbox
and manage `gmail.modify`, send `gmail.send`. A granted scope outside this
list is kept as text in `grantedScopes` and grants nothing. Older stored grants
keep their recorded scopes and encrypted credential. The service uses an old
active grant only after the credential opens and matches the stored expiry.
A refreshable grant must contain a refresh token. A grant whose credential
cannot be verified requires reconnection.

```quint
import types.* from "../../shared/types"
import oauth as O from "../../../core/oauth"
import registry as N from "../../nativeClients/registry"
type GoogleCapability = BasicIdentity | GmailTriage | GmailSend | GmailManage | GmailDrafts | GmailMailbox | CalendarRead | CalendarWrite
type GoogleScope = ScopeOpenId | ScopeUserinfoEmail | ScopeUserinfoProfile | ScopeCalendarReadonly | ScopeCalendarEvents | ScopeCalendar | ScopeGmailMetadata | ScopeGmailReadonly | ScopeGmailCompose | ScopeGmailModify | ScopeGmailSend
pure val allCapabilities: List[GoogleCapability] = List(BasicIdentity, GmailTriage, GmailSend, GmailManage, GmailDrafts, GmailMailbox, CalendarRead, CalendarWrite)
pure val allScopes: List[GoogleScope] = List(ScopeOpenId, ScopeUserinfoEmail, ScopeUserinfoProfile, ScopeCalendarReadonly, ScopeCalendarEvents, ScopeCalendar, ScopeGmailMetadata, ScopeGmailReadonly, ScopeGmailCompose, ScopeGmailModify, ScopeGmailSend)
pure def scopesFor(k: GoogleCapability): List[GoogleScope] =
  if (k == BasicIdentity) List(ScopeUserinfoEmail, ScopeUserinfoProfile) else if (k == GmailTriage) List(ScopeGmailReadonly) else if (k == GmailSend) List(ScopeGmailSend)
  else if (k == GmailDrafts) List(ScopeGmailCompose) else if (k == GmailManage or k == GmailMailbox) List(ScopeGmailModify) else List(ScopeCalendarEvents)
pure def requestedScopes(asked: List[GoogleCapability]): List[GoogleScope] = allScopes.select(s => asked.append(BasicIdentity).some(k => scopesFor(k).includes(s)))
pure def grantsCapability(scopes: List[GoogleScope], k: GoogleCapability): bool = {
  val enough = if (k == BasicIdentity) List(ScopeOpenId, ScopeUserinfoEmail, ScopeUserinfoProfile) else if (k == CalendarRead) List(ScopeCalendarReadonly, ScopeCalendarEvents, ScopeCalendar)
    else if (k == CalendarWrite) List(ScopeCalendarEvents, ScopeCalendar) else if (k == GmailTriage) List(ScopeGmailMetadata, ScopeGmailReadonly, ScopeGmailModify, ScopeGmailCompose)
    else if (k == GmailDrafts) List(ScopeGmailCompose, ScopeGmailModify) else if (k == GmailSend) List(ScopeGmailSend) else List(ScopeGmailModify)
  enough.some(s => scopes.includes(s))
}
pure def capabilitiesOf(scopes: List[GoogleScope]): List[GoogleCapability] = allCapabilities.select(k => grantsCapability(scopes, k))
pure def scopesOf(granted: List[GoogleScope]): List[GoogleScope] = allScopes.select(s => granted.includes(s))
pure val askedValues = Set(List(), List(GmailTriage), List(GmailSend, CalendarWrite), List(GmailManage, GmailDrafts), List(GmailMailbox, CalendarRead))
pure val scopesValues = Set(List(), List(ScopeGmailModify), List(ScopeCalendarReadonly, ScopeGmailCompose), List(ScopeCalendar, ScopeGmailMetadata, ScopeGmailSend), List(ScopeOpenId))
pure def lawEveryAskedCapabilityIsGrantedByItsScopes(asked: List[GoogleCapability]): bool = asked.every(k => capabilitiesOf(requestedScopes(asked)).includes(k))
pure def lawStrongerAccessImpliesWeaker(scopes: List[GoogleScope]): bool = {
  val held = capabilitiesOf(scopes)
  (held.includes(CalendarWrite) implies held.includes(CalendarRead)) and (held.includes(GmailManage) iff held.includes(GmailMailbox)) and (held.includes(GmailMailbox) implies (held.includes(GmailTriage) and held.includes(GmailDrafts)))
}
```

### Initiate is admitted only for the owner side, at least one capability, Google configured, and either no return or the exact connect return of one enabled registration with one state parameter

The shell strips the one `state` query parameter (`[A-Za-z0-9_-]{43}`) from
`redirectUrl` and passes what `N::returnsAt` finds for the rest. An admitted
initiate answers `{authUrl}`, with `appReturn: 2` when it has a
`redirectUrl`; a refused one stores nothing.

```quint
type Side = OwnerSide | OtherSide
type AppReturnFit = NoAppReturn | RegisteredConnectReturn | UnregisteredReturn | MalformedReturnState
type ConnectRequest = { side: Side, capabilities: List[GoogleCapability], appReturn: AppReturnFit }
pure def appReturnFit(entries: List[N::ReturnEntry], stateWellFormed: bool): AppReturnFit =
  if (not(stateWellFormed)) MalformedReturnState else if (entries.length() == 1 and entries.every(e => e.purpose == N::ConnectPurpose)) RegisteredConnectReturn else UnregisteredReturn
pure def initiateAdmitted(configured: bool, request: ConnectRequest): bool =
  request.side == OwnerSide and request.capabilities.length() > 0 and configured and (request.appReturn == NoAppReturn or request.appReturn == RegisteredConnectReturn)
pure def initiateRefusal(configured: bool, request: ConnectRequest): Refusal =
  if (request.side != OwnerSide or request.capabilities.length() == 0 or request.appReturn == MalformedReturnState) refuse(InvalidRequest)
  else if (not(configured)) refuseFor(ProviderUnavailable, GoogleNotConfigured) else N::faultRefusal(N::WrongRedirect)
pure val requestValues: Set[ConnectRequest] = {
  val ok: ConnectRequest = { side: OwnerSide, capabilities: List(GmailTriage, CalendarRead), appReturn: NoAppReturn }
  Set(ok, { ...ok, appReturn: RegisteredConnectReturn }, { ...ok, side: OtherSide }, { ...ok, capabilities: List() }, { ...ok, appReturn: UnregisteredReturn }, { ...ok, appReturn: MalformedReturnState })
}
pure def lawAnInitiateRefusalIsFinal(configured: bool, request: ConnectRequest): bool =
  not(initiateAdmitted(configured, request)) implies (wellFormed(initiateRefusal(configured, request)) and not(retryableOf(initiateRefusal(configured, request))))
```

### Every step of a connect attempt is a step of core's OAuth flow, and its state lives ten minutes

So the attempt is stored before the Google URL is built, the callback
consumes it once before the token exchange, and a failed write after a
failure keeps both causes (`spec/core/oauth/index.md`). Google's PKCE
verifier is always required and nothing is compensated. A row has no attempt
fields before its attempt begins.

```quint
type ConnectionStatus = Pending | Active | Expired | Revoked | Errored
type GrantTokens = NoTokens | SealedTokens({ expiresAt: Millis, hasRefreshToken: bool })
type Exchange = NotExchanged | Exchanged({ subject: str, accessUntil: Millis, refreshable: bool })
type CallbackKind = NoCallback | CodeCallback | DeniedCallback | IncompleteCallback
type Connection = { flow: O::OAuthFlow, stateExpiresAt: Millis, callback: CallbackKind, exchange: Exchange, offered: List[GoogleScope], landedOnHeld: bool, status: ConnectionStatus, subject: str, scopes: List[GoogleScope], tokens: GrantTokens, refreshing: bool, now: Millis }
pure val stateLifetime: Millis = 10 * millisPerMinute
pure val initial: Connection = { flow: O::initial, stateExpiresAt: 0, callback: NoCallback, exchange: NotExchanged, offered: List(), landedOnHeld: false, status: Pending, subject: "", scopes: List(), tokens: NoTokens, refreshing: false, now: 0 }
pure def refinesO(c: Connection): O::OAuthFlow = c.flow
pure def canBegin(c: Connection, supported: bool, configured: bool, request: ConnectRequest): bool = c.flow.phase == O::FlowIdle and c.status == Pending and supported and initiateAdmitted(configured, request)
pure def begin(c: Connection, supported: bool, configured: bool, request: ConnectRequest): Connection = { ...c, flow: O::begin(c.flow, supported), stateExpiresAt: c.now + stateLifetime }
pure def canElapse(c: Connection, elapsed: Millis): bool = elapsed > 0
pure def elapse(c: Connection, elapsed: Millis): Connection = { ...c, now: c.now + elapsed }
pure def canCreateResult(c: Connection): bool = O::canCreateResult(c.flow)
pure def createResult(c: Connection, success: bool): Connection = { ...c, flow: O::createResult(c.flow, success) }
pure def canStartProviderResult(c: Connection): bool = O::canStartProviderResult(c.flow)
pure def startProviderResult(c: Connection, success: bool): Connection = { ...c, flow: O::startProviderResult(c.flow, success) }
pure def canWriteStart(c: Connection): bool = O::canWriteStart(c.flow)
pure def writeStart(c: Connection, write: O::FlowWrite): Connection = { ...c, flow: O::writeStart(c.flow, write) }
pure def canBeginCallback(c: Connection, verifierRequired: bool): bool = O::canBeginCallback(c.flow) and verifierRequired
pure def beginCallback(c: Connection, verifierPresent: bool, verifierRequired: bool): Connection = { ...c, flow: O::beginCallback(c.flow, verifierPresent, verifierRequired) }
pure def canConsume(c: Connection, pendingAndUnexpired: bool, inputError: bool, providerInstalled: bool, callback: CallbackKind): bool =
  O::canConsume(c.flow) and providerInstalled and callback != NoCallback and pendingAndUnexpired == (c.now < c.stateExpiresAt) and inputError == (callback != CodeCallback)
pure def consume(c: Connection, pendingAndUnexpired: bool, inputError: bool, providerInstalled: bool, callback: CallbackKind): Connection =
  { ...c, flow: O::consume(c.flow, pendingAndUnexpired, inputError, providerInstalled), callback: callback }
pure def canCompensate(c: Connection, supported: bool): bool = O::canCompensate(c.flow) and not(supported)
pure def compensate(c: Connection, supported: bool, success: bool): Connection = { ...c, flow: O::compensate(c.flow, supported, success) }
pure def canWriteFailure(c: Connection): bool = O::canWriteFailure(c.flow)
pure def writeFailure(c: Connection, write: O::FlowWrite): Connection = { ...c, flow: O::writeFailure(c.flow, write) }
pure def canWriteSuccess(c: Connection, selectedStatus: O::FlowState): bool = O::canWriteSuccess(c.flow) and selectedStatus == O::CompletedState
pure def writeSuccess(c: Connection, write: O::FlowWrite, selectedStatus: O::FlowState): Connection = { ...c, flow: O::writeSuccess(c.flow, write, selectedStatus) }
pure val providerInstalledValues = Set(true)
pure val verifierRequiredValues = Set(true)
pure val callbackValues = Set(CodeCallback, DeniedCallback, IncompleteCallback)
pure val selectedStatusValues = Set(O::CompletedState)
pure val elapsedValues = Set(1, 60000, 600000)
pure val weight_begin = 3
pure val weight_createResult = 3
pure val weight_startProviderResult = 3
pure val weight_writeStart = 3
pure val weight_beginCallback = 3
pure val weight_consume = 4
pure val weight_writeSuccess = 3
pure def alwaysAnIdleRowHasNoAttempt(c: Connection): bool =
  c.flow.phase == O::FlowIdle implies (c.callback == NoCallback and c.exchange == NotExchanged and not(c.landedOnHeld) and not(c.flow.accountStored))
pure def sometimesAwaitingGoogle(c: Connection): bool = c.flow.phase == O::AwaitingCallback and c.now < c.stateExpiresAt
```

### The callback stores the sealed grant only on the one connection of its Google subject

Google's answer names the subject, the granted scopes, the access token's
lifetime and whether a refresh token came. When the organization already
holds that subject (`subjectHeld`), the grant goes to that row by
`receiveGrant` and this attempt row stays `Pending`; otherwise this row
becomes the subject's connection. A row's subject, once set, never changes.

```quint
pure def canProviderResult(c: Connection, hasAccount: bool, subject: str, lifetime: Millis): bool = O::canProviderResult(c.flow) and hasAccount and subject != "" and lifetime > 0
pure def providerResult(c: Connection, success: bool, hasAccount: bool, subject: str, granted: List[GoogleScope], lifetime: Millis, refreshable: bool): Connection =
  { ...c, flow: O::providerResult(c.flow, success, hasAccount), exchange: if (success) Exchanged({ subject: subject, accessUntil: c.now + lifetime, refreshable: refreshable }) else NotExchanged, offered: if (success) scopesOf(granted) else List() }
pure def canAccountResult(c: Connection): bool = O::canAccountResult(c.flow) and c.exchange != NotExchanged
pure def accountResult(c: Connection, success: bool, subjectHeld: bool): Connection = {
  val x = c.exchange
  val flow = O::accountResult(c.flow, success)
  match x {
    | Exchanged(e) => if (success and not(subjectHeld)) { ...c, flow: flow, status: Active, subject: e.subject, scopes: c.offered, tokens: SealedTokens({ expiresAt: e.accessUntil, hasRefreshToken: e.refreshable }), landedOnHeld: false }
        else { ...c, flow: flow, landedOnHeld: success }
    | NotExchanged => { ...c, flow: flow }
  }
}
pure val hasAccountValues = Set(true)
pure val subjectValues = Set("sub1", "sub2")
pure val grantedValues = Set(List(ScopeUserinfoEmail, ScopeGmailReadonly), List(ScopeUserinfoEmail, ScopeGmailModify, ScopeCalendarEvents, ScopeGmailSend))
pure val lifetimeValues = Set(120000, 3600000)
pure val weight_providerResult = 4
pure val weight_accountResult = 4
pure def alwaysAnExchangeNamesASubject(c: Connection): bool = { val x = c.exchange
  match x { | Exchanged(e) => e.subject != "" | NotExchanged => true } }
pure def beforeTheGrant(c: Connection): bool = Set(O::CreatePending, O::StartProviderPending, O::StartFailureWrite, O::StartSuccessWrite, O::AwaitingCallback, O::ConsumePending, O::ProviderPending, O::AccountPending).contains(c.flow.phase)
pure def alwaysAnAttemptRowStaysPendingUntilItsGrant(c: Connection): bool = beforeTheGrant(c) implies c.status == Pending
pure def alwaysOnlyAPendingRowLacksASubject(c: Connection): bool = (c.status == Pending) iff (c.subject == "")
pure def alwaysAStoredGrantHasItsConnection(c: Connection): bool = (c.flow.accountStored implies (c.status != Pending or c.landedOnHeld)) and (c.landedOnHeld implies (c.flow.accountStored and c.status == Pending))
pure def stepSubjectNeverChanges(before: Connection, after: Connection): bool = before.subject != "" implies after.subject == before.subject
pure def sometimesConnectedInTheBrowser(c: Connection): bool = c.status == Active and c.flow.accountStored and c.flow.phase == O::FlowReturned
pure def sometimesJoinedTheSubjectsConnection(c: Connection): bool = c.landedOnHeld and c.flow.phase == O::FlowReturned
```

### The callback returns connected only with the grant stored, denied when the owner refused at Google, and failed otherwise, and an unconsumed attempt never returns to the app

With a `redirectUrl` the answer redirects to it with the fragment `state`,
`result` and, when connected, `connectionId` (the row the grant landed on);
without one it shows ReturnToApp purpose `connected` (`spec/cloud/returnPages.md`).
An unknown or expired attempt is shown failed on a page of the cloud.

```quint
type ConnectResult = Connected | Denied | Failed
type CallbackAnswer = AwaitingResult | ReturnResult({ result: ConnectResult }) | ShowFailedPage
pure def callbackAnswerOf(c: Connection): CallbackAnswer =
  if (c.callback == NoCallback or not(c.flow.phase == O::FlowReturned or c.flow.phase == O::FlowThrown)) AwaitingResult
  else if (not(c.flow.consumed)) ShowFailedPage
  else ReturnResult({ result: if (c.flow.accountStored) Connected else if (c.callback == DeniedCallback) Denied else Failed })
pure def alwaysConnectedNamesAHeldGrant(c: Connection): bool = callbackAnswerOf(c) == ReturnResult({ result: Connected }) implies (c.status != Pending or c.landedOnHeld)
pure def sometimesDeniedAtGoogle(c: Connection): bool = callbackAnswerOf(c) == ReturnResult({ result: Denied })
pure def sometimesExpiredAttemptShownOnTheCloud(c: Connection): bool = callbackAnswerOf(c) == ShowFailedPage and c.callback == CodeCallback
```

### A later grant for the same Google subject, or a native code for a new one, replaces the connection's tokens and scopes and makes it active

`connect/native` exchanges the device's one-time server auth code (Google
refuses a used one) for Cloud's configured native server client, with no
browser redirect. The grant lands for the authenticated cloud owner on the
row of its verified Google subject when held, else on a fresh row with no
attempt. A native sign-in continuation can provide `expectedGoogleSubject`.
A different returned subject stores nothing. The answer names the connection
and its reported scopes, with verified email and display name when available.
If Google omits a refresh token, a verified refresh token from the same
active grant can be retained only with the same reported scopes.

```quint
pure def canReceiveGrant(c: Connection, subject: str, lifetime: Millis): bool =
  subject != "" and lifetime > 0 and ((c.status != Pending and subject == c.subject) or (c.status == Pending and c.flow.phase == O::FlowIdle))
pure def receiveGrant(c: Connection, subject: str, granted: List[GoogleScope], lifetime: Millis, refreshable: bool): Connection =
  { ...c, status: Active, subject: subject, scopes: scopesOf(granted), tokens: SealedTokens({ expiresAt: c.now + lifetime, hasRefreshToken: refreshable }), refreshing: false }
pure def stepOnlyANewGrantRevivesAConnection(before: Connection, via: str, after: Connection): bool =
  (before.status != Active and after.status == Active) implies (via == "accountResult" or via == "receiveGrant")
pure def sometimesLinkedNatively(c: Connection): bool = c.status == Active and c.flow.phase == O::FlowIdle
```

### Access is refreshed within five minutes of expiry, one refresh at a time, and Google's invalid_grant expires the connection

A refused grant, or a token that no longer decrypts, is `Expired`; a
rotated refresh token that could not be stored is `Errored`; an outage
leaves the connection active. A result arriving after a disconnect or a new
grant is dropped.

```quint
type RefreshOutcome = Refreshed | GrantRefused | RotationNotStored | RefreshUnavailable
pure val refreshLead: Millis = 5 * millisPerMinute
pure def refreshDue(c: Connection): bool = { val t = c.tokens
  match t { | SealedTokens(x) => x.hasRefreshToken and c.now + refreshLead >= x.expiresAt | NoTokens => false } }
pure def hasTokens(c: Connection): bool = c.tokens != NoTokens
pure def canBeginRefresh(c: Connection): bool = c.status == Active and not(c.refreshing) and refreshDue(c)
pure def beginRefresh(c: Connection): Connection = { ...c, refreshing: true }
pure def canFinishRefresh(c: Connection, lifetime: Millis): bool = c.refreshing and lifetime > 0
pure def finishRefresh(c: Connection, answer: RefreshOutcome, lifetime: Millis): Connection = {
  val t = c.tokens
  val renewed = match t { | SealedTokens(x) => SealedTokens({ expiresAt: c.now + lifetime, hasRefreshToken: x.hasRefreshToken }) | NoTokens => NoTokens }
  if (answer == Refreshed) { ...c, refreshing: false, tokens: renewed }
  else if (answer == GrantRefused) { ...c, refreshing: false, status: Expired }
  else if (answer == RotationNotStored) { ...c, refreshing: false, status: Errored }
  else { ...c, refreshing: false }
}
pure val weight_beginRefresh = 3
pure val weight_finishRefresh = 3
pure def alwaysTokensExactlyWhileGranted(c: Connection): bool = hasTokens(c) iff (c.status == Active or c.status == Expired or c.status == Errored)
pure def holdsRefreshToken(c: Connection): bool = { val t = c.tokens
  match t { | SealedTokens(x) => x.hasRefreshToken | NoTokens => false } }
pure def alwaysOneRefreshOnlyWhileActive(c: Connection): bool = c.refreshing implies (c.status == Active and holdsRefreshToken(c))
pure def sometimesRefreshing(c: Connection): bool = c.refreshing
pure def sometimesExpiredByGoogle(c: Connection): bool = c.status == Expired
pure def sometimesRotationLost(c: Connection): bool = c.status == Errored
```

## Story: See my Google connection as the cloud holds it

> As an owner, I want one status that says whether my Google account is
> connected, why not if it is not, and exactly what it lets my assistant do,
> so that I reconnect only when I must.

### A request names a grant or uses the only active connection, never another organization's, and only the owner side

A Google route that needs one grant, including disconnect, selects this way
over the caller's organization's rows, newest first. A named grant outside
those rows returns `404 not_found`. With no named grant, several active rows
return `400 invalid_request` with reason `grant_required`. If no row is
active, selection uses the newest established grant. A `side` other than
`owner` returns `400 invalid_request`.

```quint
type GrantChoice = AnyGrant | NamedGrant({ grantId: str })
type GrantView = { grantId: str, organization: str, status: ConnectionStatus }
type SelectionFault = SideNotOwner | SeveralActiveGrants | GrantUnknown
type Selection = SelectedGrant({ grantId: str }) | NoGrantHeld | SelectionRefused({ fault: SelectionFault })
pure def selectGrant(rows: List[GrantView], organization: str, side: Side, choice: GrantChoice): Selection = {
  val held = rows.select(r => r.organization == organization and r.status != Pending)
  val active = held.select(r => r.status == Active)
  val newest = held.foldl("", (acc, r) => if (acc == "") r.grantId else acc)
  if (side != OwnerSide) SelectionRefused({ fault: SideNotOwner })
  else match choice {
    | NamedGrant(g) => if (held.some(r => r.grantId == g.grantId)) SelectedGrant({ grantId: g.grantId }) else SelectionRefused({ fault: GrantUnknown })
    | AnyGrant => if (active.length() > 1) SelectionRefused({ fault: SeveralActiveGrants }) else if (active.length() == 1) SelectedGrant({ grantId: active.foldl("", (acc, r) => r.grantId) }) else if (newest != "") SelectedGrant({ grantId: newest }) else NoGrantHeld
  }
}
pure def selectionRefusal(fault: SelectionFault): Refusal = if (fault == SideNotOwner) refuse(InvalidRequest) else if (fault == SeveralActiveGrants) refuseFor(InvalidRequest, GrantRequired) else refuse(NotFound)
pure val rowsValues: Set[List[GrantView]] = Set(List(), List({ grantId: "g1", organization: "o1", status: Active }), List({ grantId: "g1", organization: "o1", status: Active }, { grantId: "g2", organization: "o1", status: Active }),
  List({ grantId: "g1", organization: "o1", status: Expired }, { grantId: "g2", organization: "o2", status: Active }), List({ grantId: "g3", organization: "o1", status: Pending }))
pure val organizationValues = Set("o1", "o2")
pure val choiceValues = Set(AnyGrant, NamedGrant({ grantId: "g1" }), NamedGrant({ grantId: "g2" }), NamedGrant({ grantId: "g3" }))
pure def lawASelectedGrantIsTheCallersConnection(rows: List[GrantView], organization: str, side: Side, choice: GrantChoice): bool = {
  val chosen = selectGrant(rows, organization, side, choice)
  match chosen { | SelectedGrant(g) => rows.some(r => r.grantId == g.grantId and r.organization == organization and r.status != Pending) | _ => true }
}
pure def lawNoGrantIsGuessedAmongSeveral(rows: List[GrantView], organization: str): bool =
  rows.select(r => r.organization == organization and r.status == Active).length() > 1 implies selectGrant(rows, organization, OwnerSide, AnyGrant) == SelectionRefused({ fault: SeveralActiveGrants })
pure def lawASelectionRefusalIsFinal(fault: SelectionFault): bool = wellFormed(selectionRefusal(fault)) and not(retryableOf(selectionRefusal(fault)))
```

### Use needs an active connection whose access is live and which holds the capability

Every Google route checks this after refreshing when due. A connection that
is not active, or whose access expired with no refresh token, is `409
google_reauth_required`; one whose refresh is due while Google is
unreachable is `503 provider_unavailable`, retryable; a missing capability
is `403 access_denied` reason `capability_missing`.

```quint
type AccessState = AccessLive | AccessRefreshable | AccessLost
pure def accessOf(c: Connection): AccessState = { val t = c.tokens
  match t { | SealedTokens(x) => if (c.now < x.expiresAt) AccessLive else if (x.hasRefreshToken) AccessRefreshable else AccessLost | NoTokens => AccessLost } }
pure def useAllowed(status: ConnectionStatus, access: AccessState, holds: bool): bool = status == Active and access == AccessLive and holds
pure def useRefusal(status: ConnectionStatus, access: AccessState, holds: bool): Refusal =
  if (status != Active or access == AccessLost) refuse(GoogleReauthRequired) else if (access == AccessRefreshable) refuse(ProviderUnavailable) else refuseFor(AccessDenied, CapabilityMissing)
pure def usable(c: Connection, need: GoogleCapability): bool = useAllowed(c.status, accessOf(c), capabilitiesOf(c.scopes).includes(need))
pure def lawOnlyAnOutageIsRetryable(status: ConnectionStatus, access: AccessState, holds: bool): bool =
  not(useAllowed(status, access, holds)) implies (wellFormed(useRefusal(status, access, holds)) and (retryableOf(useRefusal(status, access, holds)) iff (status == Active and access == AccessRefreshable)))
```

### The status says connected exactly when a use of a granted capability can succeed now or after a refresh

`GET status` answers `{provider: "google", side: "owner", mode:
"cloud_managed", configured, connected, reason, identity,
grantedCapabilities, grantedScopes, expiresAt, hasRefreshToken,
connectionId, linkedAt, lastUsedAt}` for the selected connection, with
`grantedCapabilities` = `capabilitiesOf` the scopes. Google off is
`config_missing` and names nothing; no connection or a revoked one is
`disconnected`; an active one whose access is lost is `token_missing`; an
expired or errored one is `needs_reauth`. Status and account listing expose
only established connections held for the caller's cloud user and organization.
`GET accounts` returns the same status records in a bare array, newest first,
and an empty array if Google is off. These reads do not refresh the grant or
change when it was last used. The status route refuses a consent `purpose`
selector because it reports the managed grant only.

```quint
type StatusReason = ReasonConnected | ReasonDisconnected | ReasonConfigMissing | ReasonTokenMissing | ReasonNeedsReauth
pure def reasonOf(configured: bool, status: ConnectionStatus, access: AccessState): StatusReason =
  if (not(configured)) ReasonConfigMissing
  else if (status == Active and access != AccessLost) ReasonConnected
  else if (status == Active) ReasonTokenMissing
  else if (status == Expired or status == Errored) ReasonNeedsReauth
  else ReasonDisconnected
pure def statusReason(configured: bool, c: Connection): StatusReason = reasonOf(configured, c.status, accessOf(c))
pure def sometimesAccessLapsedWithoutRefresh(c: Connection): bool = statusReason(true, c) == ReasonTokenMissing
pure def lawConnectedExactlyWhenUseCanSucceed(status: ConnectionStatus, access: AccessState): bool =
  (reasonOf(true, status, access) == ReasonConnected) iff (useAllowed(status, access, true) or (status == Active and useRefusal(status, access, true).code == ProviderUnavailable))
```

## Story: Disconnect it

> As an owner, I want disconnecting Google to end the cloud's access at once,
> so that nothing the cloud kept can read my mail or calendar afterwards.

### Disconnect revokes the grant at Google, then erases its tokens and scopes and marks it revoked, whatever Google answered

The shell calls Google's revoke endpoint with the refresh token (else the
access token) first; a Google failure is logged and does not keep the
tokens. Disconnecting a connection already revoked answers `{ok: true}` and
changes nothing; only a new grant for the same subject makes it active again.

```quint
pure def canDisconnect(c: Connection): bool = hasTokens(c)
pure def disconnect(c: Connection): Connection = { ...c, status: Revoked, tokens: NoTokens, scopes: List(), refreshing: false }
pure def alwaysARevokedConnectionGrantsNothing(c: Connection): bool = c.status == Revoked implies c.scopes == List()
pure def sometimesRevoked(c: Connection): bool = c.status == Revoked
```

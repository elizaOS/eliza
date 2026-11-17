# Route access

Every route of the host has a mode, and the mode decides which callers it
admits. The owner proves who they are with a session that [auth
sessions](../../auth/sessions.md) verified; a device the owner pairs with
the host directly redeems a one-time code for that session below, and a
connector account proves it belongs to the owner at
[owner pairing](./ownerPairing.md). The pairing link a device reads is the
[remote agent pairing contract](../../contracts/remoteAgentPairing.md);
pairing a controller through the cloud is
[cloud remote pairing](../../cloud/remotePairing.md). Memory ingested from a
conversation is scoped to its sender unless the owner wrote it in a private
room.

## Story: Admit only the callers a route allows

> As the owner, only I and the devices I paired can use my agent's private
> routes, and nothing else on my machine or network can act as me.

### No private route admits a caller without a verified session

A private route needs a verified
session: the owner's auth session, a paired device's credential or the
host session handed to a local process. The owner's session counts as
verified only while [auth sessions](../../auth/sessions.md) accepts its
access token, so a revoked or expired session admits nothing. A request from
the loopback interface is no exception: loopback alone is never authority.

```quint
import sessions as S from "../../auth/sessions"
type CallerKind = OwnerCaller | PairedDevice | LocalProcess | RemoteCaller
type RouteMode = PublicRoute | OwnerRoute | DeviceRoute | ConfigRoute
pure def verifiedOwner(kind: CallerKind, session: bool): bool = kind == OwnerCaller and session
pure def admits(mode: RouteMode, kind: CallerKind, session: bool, loopback: bool): bool =
  if (mode == PublicRoute) true
  else if (mode == OwnerRoute) verifiedOwner(kind, session) or (kind == LocalProcess and loopback and session)
  else if (mode == DeviceRoute) verifiedOwner(kind, session) or (kind == PairedDevice and session)
  else verifiedOwner(kind, session)
pure def ownerSessionVerified(sessions: S::Sessions, access: int): bool = S::accepts(sessions, access)
pure def ownerAdmitted(mode: RouteMode, sessions: S::Sessions, access: int, loopback: bool): bool =
  admits(mode, OwnerCaller, ownerSessionVerified(sessions, access), loopback)
pure def lawPrivateRoutesNeedASession(mode: RouteMode, kind: CallerKind, loopback: bool): bool =
  mode != PublicRoute implies not(admits(mode, kind, false, loopback))
```

### A public route admits every caller

```quint
pure def lawPublicRouteAdmitsEveryone(kind: CallerKind, session: bool, loopback: bool): bool = admits(PublicRoute, kind, session, loopback)
```

### Only the verified owner changes configuration

```quint
pure def lawConfigurationIsOwnerOnly(kind: CallerKind, session: bool, loopback: bool): bool =
  admits(ConfigRoute, kind, session, loopback) implies verifiedOwner(kind, session)
```

### A paired device reaches device routes but never owner routes

```quint
pure def lawPairedDeviceStaysOnDeviceRoutes(session: bool, loopback: bool): bool =
  not(admits(OwnerRoute, PairedDevice, session, loopback)) and not(admits(ConfigRoute, PairedDevice, session, loopback))
```

### A remote caller reaches only public routes

```quint
pure def lawRemoteCallerOnlyPublic(mode: RouteMode, session: bool, loopback: bool): bool =
  admits(mode, RemoteCaller, session, loopback) implies mode == PublicRoute
```

### The dashboard bootstrap and the read-only query grant no write capability

The bootstrap a dashboard loads before sign-in carries only the configured
settings on the public allowlist, so it never carries an API token, and it
writes nothing to local storage. The read-only database action runs a
single statement only when every verb it executes, including those nested
in a subquery or common table expression, is a read; it refuses any write,
schema change or batch of statements.

```quint
type SettingName = AgentNameSetting | ThemeSetting | ApiTokenSetting | PairingSecretSetting
pure val publicSettings: Set[SettingName] = Set(AgentNameSetting, ThemeSetting)
pure def bootstrap(configured: Set[SettingName]): Set[SettingName] = configured.filter(name => publicSettings.contains(name))
pure def grantsCapability(name: SettingName): bool = match name {
  | AgentNameSetting => false
  | ThemeSetting => false
  | ApiTokenSetting => true
  | PairingSecretSetting => true
}
type SqlVerb = SelectVerb | ShowVerb | InsertVerb | UpdateVerb | DeleteVerb | CreateVerb | AlterVerb | DropVerb
type SqlQuery = { statements: int, verbs: Set[SqlVerb] }
pure val readVerbs: Set[SqlVerb] = Set(SelectVerb, ShowVerb)
pure def readOnlyAdmits(query: SqlQuery): bool = query.statements == 1 and query.verbs.size() > 0 and query.verbs.subseteq(readVerbs)
pure def changesData(verb: SqlVerb): bool = match verb {
  | SelectVerb => false
  | ShowVerb => false
  | InsertVerb => true
  | UpdateVerb => true
  | DeleteVerb => true
  | CreateVerb => true
  | AlterVerb => true
  | DropVerb => true
}
pure def lawReadSurfacesGrantNoWrite(configured: Set[SettingName], query: SqlQuery): bool =
  bootstrap(configured).forall(name => not(grantsCapability(name))) and
  (readOnlyAdmits(query) implies query.statements == 1 and query.verbs.forall(verb => not(changesData(verb))))
pure val configuredValues = Set(Set(), Set(AgentNameSetting, ApiTokenSetting), Set(AgentNameSetting, ThemeSetting, ApiTokenSetting, PairingSecretSetting))
pure val queryValues = Set({ statements: 1, verbs: Set(SelectVerb) }, { statements: 1, verbs: Set(SelectVerb, DeleteVerb) },
  { statements: 2, verbs: Set(SelectVerb) }, { statements: 1, verbs: Set(ShowVerb, InsertVerb) }, { statements: 1, verbs: Set(DropVerb) })
```

## Story: Keep ingested memory private to its sender

> As the owner, what someone else tells my agent stays theirs, and what I
> say in a private room stays mine.

### Ingested memory is owner-private only for the owner in a private room

Memory is owner-private only when the owner wrote it in a private room;
otherwise it is private to its sender. Either way, no one but the person
who said it can read it.

```quint
type MemoryScope = OwnerPrivate | SenderPrivate
pure val ownerPerson = 0
pure def ingestScope(fromOwner: bool, privateRoom: bool): MemoryScope = if (fromOwner and privateRoom) OwnerPrivate else SenderPrivate
pure def readableBy(scope: MemoryScope, sender: int, reader: int): bool =
  if (scope == OwnerPrivate) reader == ownerPerson else reader == sender
pure def lawIngestedMemoryReadableOnlyBySender(sender: int, privateRoom: bool, reader: int): bool =
  readableBy(ingestScope(sender == ownerPerson, privateRoom), sender, reader) implies reader == sender
pure val senderValues = Set(0, 1, 2)
pure val readerValues = Set(0, 1, 2)
```

## Story: Pair a device with the exact selected agent instance

> As the owner of an agent, I pair my device with the instance I selected,
> after checking that I trust its origin; the code I was shown can be used
> once, and the session I get back is the one the agent then describes to
> me.

### The agent host consumes a code only after admitting session minting

Only a trusted operator of a deployment with pairing enabled, and not
managed, reads the owner or guest code. Redeeming it needs the exact current
instance and a known peer address; an expired code is refused, invalid
attempts spend the rate limit, and a missing session store asks the device
to retry and keeps the code. Once ready, the host consumes the code before it
mints the session, so a failed mint cannot restore it; a success issues a
session with the code's owner or guest access.

```quint
type PairAccess = PairedOwner | PairedGuest
type PairPhase = UnissuedCode | AvailableCode | MintingSession | SessionIssued | SessionIssueFailed
type PairReply = NoPairReply | RetryPairing | MismatchedPairing | ExpiredPairing | InvalidPairing | ThrottledPairing | PairingDisabled | IssuedPairing | FailedPairing
type HostPairing = { phase: PairPhase, role: PairAccess, serial: int, sessionId: int, reply: PairReply, boot: int, codeBoot: int, issuedInstance: int, issuedAccess: PairAccess }
pure val initial: HostPairing = { phase: UnissuedCode, role: PairedOwner, serial: 0, sessionId: 0, reply: NoPairReply, boot: 1, codeBoot: 0, issuedInstance: 0, issuedAccess: PairedOwner }
pure def canIssueCode(s: HostPairing, operator: bool, pairingEnabled: bool): bool = s.phase == UnissuedCode and operator and pairingEnabled
pure def issueCode(s: HostPairing, operator: bool, pairingEnabled: bool, access: PairAccess): HostPairing =
  { ...s, phase: AvailableCode, role: access, serial: s.serial + 1, codeBoot: s.boot }
pure val instanceValues = Set(1, 2)
pure def canRedeemCode(s: HostPairing): bool = s.phase != MintingSession
pure def redeemCode(s: HostPairing, pairingEnabled: bool, peerKnown: bool, instance: int, tokenExact: bool, codeExpired: bool, hasBudget: bool, storeReady: bool): HostPairing =
  if (not(pairingEnabled)) { ...s, reply: PairingDisabled }
  else if (not(peerKnown)) { ...s, reply: InvalidPairing }
  else if (instance != s.boot) { ...s, reply: MismatchedPairing }
  else if (s.phase == AvailableCode and tokenExact and codeExpired) { ...s, phase: UnissuedCode, reply: ExpiredPairing }
  else if (s.phase != AvailableCode or not(tokenExact)) { ...s, reply: if (hasBudget) InvalidPairing else ThrottledPairing }
  else if (not(storeReady)) { ...s, reply: RetryPairing }
  else { ...s, phase: MintingSession, reply: NoPairReply }
pure def canFinishMint(s: HostPairing): bool = s.phase == MintingSession
pure def finishMint(s: HostPairing, saved: bool): HostPairing =
  if (saved) { ...s, phase: SessionIssued, sessionId: s.serial, reply: IssuedPairing, issuedInstance: s.codeBoot, issuedAccess: s.role }
  else { ...s, phase: SessionIssueFailed, reply: FailedPairing }
pure def alwaysPairingCoordinates(s: HostPairing): bool =
  s.serial >= 0 and s.sessionId >= 0 and s.sessionId <= s.serial and
  ((s.phase == SessionIssued) == (s.sessionId > 0)) and (s.phase != UnissuedCode implies s.serial > 0)
pure def alwaysTransientPairReplyKeepsCode(s: HostPairing): bool = s.reply == RetryPairing implies s.phase == AvailableCode
pure def stepFinishedMintCannotBeRepeated(before: HostPairing, via: str, after: HostPairing): bool =
  ((before.phase == SessionIssued or before.phase == SessionIssueFailed) and via == "redeemCode") implies
    after.phase == before.phase and after.sessionId == before.sessionId
pure def sometimesPairingRetries(s: HostPairing): bool = s.reply == RetryPairing
pure def sometimesGuestPaired(s: HostPairing): bool = s.phase == SessionIssued and s.role == PairedGuest
pure def sometimesCodeConsumedWithoutSession(s: HostPairing): bool = s.phase == SessionIssueFailed
```

### Each boot mints its own root token and instance, and a restart drops an unredeemed code

The host process mints a new root token and instance at every boot. A root
token or instance of an earlier boot authenticates nothing and redeems
nothing, so a code issued before a restart can no longer be used: the
restart drops it. A restart waits for a session being minted to finish.

```quint
pure def rootTokenAdmits(currentBoot: int, presentedBoot: int): bool = presentedBoot > 0 and presentedBoot == currentBoot
pure def canRestartHost(s: HostPairing): bool = s.phase != MintingSession
pure def restartHost(s: HostPairing): HostPairing =
  if (s.phase == AvailableCode) { ...s, boot: s.boot + 1, phase: UnissuedCode, reply: NoPairReply } else { ...s, boot: s.boot + 1 }
pure val presentedBootValues = Set(1, 2, 3)
pure val currentBootValues = Set(1, 2)
pure def lawEarlierRootTokenIsRefused(currentBoot: int, presentedBoot: int): bool =
  presentedBoot != currentBoot implies not(rootTokenAdmits(currentBoot, presentedBoot))
pure def alwaysALiveCodeBelongsToThisBoot(s: HostPairing): bool =
  s.boot > 0 and ((s.phase == AvailableCode or s.phase == MintingSession) implies s.codeBoot == s.boot)
pure def stepOnlyARestartStartsABoot(before: HostPairing, via: str, after: HostPairing): bool =
  after.boot != before.boot implies (via == "restartHost" and after.boot == before.boot + 1)
pure def sometimesRestartDroppedTheCode(s: HostPairing): bool = s.phase == UnissuedCode and s.boot > 1 and s.serial > 0
```

### A pairing reply names the instance the code was redeemed on and the code's access

The device compares the reply with the status reply it read before
redeeming: the issued session's instance is the one that issued the code,
and its access is the code's owner or guest access.

```quint
pure def alwaysIssuedSessionNamesItsInstanceAndAccess(s: HostPairing): bool =
  s.phase == SessionIssued implies (s.issuedInstance == s.codeBoot and s.issuedInstance > 0 and s.issuedAccess == s.role)
```

### The session self-description names the session the caller presented, with an expiry still ahead

Asked who the caller is, the host describes the session the caller's
bearer token names: its id is that token, its kind is the paired device
session, and its expiry is still ahead. A revoked or expired session is
refused, never described.

```quint
type PresentedSession = { token: int, deviceSession: bool, expiresAt: int, revoked: bool }
type SessionDescription = { admitted: bool, sessionId: int, deviceSession: bool, expiresAt: int }
pure def describeSession(presented: PresentedSession, now: int): SessionDescription =
  if (presented.revoked or presented.expiresAt <= now) { admitted: false, sessionId: 0, deviceSession: false, expiresAt: 0 }
  else { admitted: true, sessionId: presented.token, deviceSession: presented.deviceSession, expiresAt: presented.expiresAt }
pure val presentedValues = Set({ token: 7, deviceSession: true, expiresAt: 10, revoked: false }, { token: 7, deviceSession: true, expiresAt: 10, revoked: true },
  { token: 8, deviceSession: false, expiresAt: 2, revoked: false })
pure val nowValues = Set(0, 5, 10)
pure def lawDescriptionNamesThePresentedSession(presented: PresentedSession, now: int): bool =
  describeSession(presented, now).admitted implies
    (describeSession(presented, now).sessionId == presented.token and describeSession(presented, now).expiresAt > now and
     describeSession(presented, now).deviceSession == presented.deviceSession)
pure def lawRevokedOrExpiredSessionIsNotDescribed(presented: PresentedSession, now: int): bool =
  (presented.revoked or presented.expiresAt <= now) implies not(describeSession(presented, now).admitted)
```

## Story: Serve only the routes my product lists

> As the maker of a product that embeds the agent, I list the routes my app
> uses; the embedded agent serves those and nothing else, and a list it
> cannot read leaves it serving nothing rather than everything.

### An embedded agent serves a request only when a listed route matches its method and every path segment

A product may hand an embedded agent a route list: each route is a method
and a path of literal segments and named parameters, each parameter with
its pattern. A request is served only when a listed route has the same
method and the same number of segments, one route segment at each position
of the path, each literal segment equal and each parameter segment fitting
its pattern. A list that is missing or does not
parse serves nothing.

```quint
type RouteSegmentAt = { position: int, param: bool, text: str }
type ListedRoute = { method: str, segments: List[RouteSegmentAt] }
type RouteList = { loaded: bool, routes: List[ListedRoute] }
type PathSegment = { text: str, fitsParam: bool }
pure val noPathSegment: PathSegment = { text: "", fitsParam: false }
pure def segmentFits(s: RouteSegmentAt, path: List[PathSegment]): bool = {
  val found = path.nthOr(s.position, noPathSegment)
  if (s.param) found.fitsParam else found.text != "" and found.text == s.text
}
pure def listedRouteMatches(r: ListedRoute, method: str, path: List[PathSegment]): bool =
  r.method == method and r.segments.length() == path.length() and
    r.segments.every(s => s.position >= 0 and s.position < path.length() and r.segments.select(o => o.position == s.position).length() == 1 and segmentFits(s, path))
pure def routeServed(routeList: RouteList, method: str, path: List[PathSegment]): bool =
  routeList.loaded and routeList.routes.some(r => listedRouteMatches(r, method, path))
pure val routeListValues = Set(
  { loaded: false, routes: List({ method: "GET", segments: List({ position: 0, param: false, text: "health" }) }) },
  { loaded: true, routes: List({ method: "GET", segments: List({ position: 0, param: false, text: "health" }) },
    { method: "POST", segments: List({ position: 0, param: false, text: "turns" }, { position: 1, param: true, text: "" }) }) }
)
pure val methodValues = Set("GET", "POST")
pure val sValues = Set({ position: 0, param: false, text: "health" }, { position: 1, param: true, text: "" }, { position: 2, param: false, text: "turns" })
pure val rValues = Set({ method: "GET", segments: List({ position: 0, param: false, text: "health" }) },
  { method: "POST", segments: List({ position: 0, param: false, text: "turns" }, { position: 1, param: true, text: "" }) })
pure val pathValues = Set(List({ text: "health", fitsParam: false }), List({ text: "turns", fitsParam: false }, { text: "t1", fitsParam: true }),
  List({ text: "turns", fitsParam: false }, { text: "x", fitsParam: false }), List())
pure def lawUnreadableRouteListServesNothing(routeList: RouteList, method: str, path: List[PathSegment]): bool =
  not(routeList.loaded) implies not(routeServed(routeList, method, path))
pure def lawServedRequestMatchesAListedMethodAndShape(routeList: RouteList, method: str, path: List[PathSegment]): bool =
  routeServed(routeList, method, path) implies routeList.routes.some(r => r.method == method and r.segments.length() == path.length())
pure def lawUnlistedMethodIsNeverServed(routeList: RouteList, method: str, path: List[PathSegment]): bool =
  not(routeList.routes.some(r => r.method == method)) implies not(routeServed(routeList, method, path))
```

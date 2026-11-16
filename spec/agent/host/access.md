# Route access

Every route of the host has a mode, and the mode decides which callers it
admits. The owner proves who they are with a session that [auth
sessions](../../auth/sessions.md) verified; a paired device proves it with
the credential issued at [owner pairing](./ownerPairing.md). Memory ingested from a
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

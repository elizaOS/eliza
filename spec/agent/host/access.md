# Route access

Every route of the host has a mode, and the mode decides which callers it
admits. The owner proves who they are with a session that
[auth sessions](../../auth/sessions.md) verified; a paired device proves it
with the credential issued at [owner pairing](./ownerPairing.md). A request
from the loopback interface is not trusted on that ground alone: a process
on the same machine needs the host session too. Memory ingested from a
conversation is scoped to its sender unless the owner wrote it in a private
room. The research baseline is `packages/agent/src/api/{auth,route-modes}.ts`,
`api/memory-scope.ts` and the `api-boundaries` model.

## Story: Admit only the callers a route allows

> As the owner, only I and the devices I paired can use my agent's private
> routes, and nothing else on my machine or network can act as me.

### A public route admits every caller

```quint
type CallerKind = OwnerCaller | PairedDevice | LocalProcess | RemoteCaller
type RouteMode = PublicRoute | OwnerRoute | DeviceRoute | ConfigRoute
pure def verifiedOwner(kind: CallerKind, session: bool): bool = kind == OwnerCaller and session
pure def admits(mode: RouteMode, kind: CallerKind, session: bool, loopback: bool): bool =
  if (mode == PublicRoute) true
  else if (mode == OwnerRoute) verifiedOwner(kind, session) or (kind == LocalProcess and loopback and session)
  else if (mode == DeviceRoute) verifiedOwner(kind, session) or (kind == PairedDevice and session)
  else verifiedOwner(kind, session)
pure def lawPublicRouteAdmitsEveryone(kind: CallerKind, session: bool, loopback: bool): bool = admits(PublicRoute, kind, session, loopback)
```

### No private route admits a caller without a verified session

The session is the owner's auth session, a paired device's credential or
the host session handed to a local process. The owner's session counts as
verified only while [auth sessions](../../auth/sessions.md) accepts its
access token, so a revoked or expired session admits nothing.

```quint
import sessions as S from "../../auth/sessions"
pure def ownerSessionVerified(sessions: S::Sessions, access: int): bool = S::accepts(sessions, access)
pure def ownerAdmitted(mode: RouteMode, sessions: S::Sessions, access: int, loopback: bool): bool =
  admits(mode, OwnerCaller, ownerSessionVerified(sessions, access), loopback)
pure def lawPrivateRoutesNeedASession(mode: RouteMode, kind: CallerKind, loopback: bool): bool =
  mode != PublicRoute implies not(admits(mode, kind, false, loopback))
```

### Loopback alone is never authority

```quint
pure def lawLoopbackIsNotAuthority(mode: RouteMode, kind: CallerKind, session: bool): bool =
  admits(mode, kind, session, true) implies (mode == PublicRoute or session)
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

## Story: Keep ingested memory private to its sender

> As the owner, what someone else tells my agent stays theirs, and what I
> say in a private room stays mine.

### Ingested memory is owner-private only for the owner in a private room

```quint
type MemoryScope = OwnerPrivate | SenderPrivate
pure def ingestScope(fromOwner: bool, privateRoom: bool): MemoryScope = if (fromOwner and privateRoom) OwnerPrivate else SenderPrivate
pure def lawOwnerPrivateNeedsOwnerInPrivateRoom(fromOwner: bool, privateRoom: bool): bool =
  ingestScope(fromOwner, privateRoom) == OwnerPrivate iff (fromOwner and privateRoom)
```

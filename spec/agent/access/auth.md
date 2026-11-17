# Local access

Who may call the agent's local API. The only device client is the
supervising host: the os bridge, which holds the per-launch token of the
[launch frame](../host/launch.md) and attaches it to every request as
`Authorization: Bearer`. Every other caller is anonymous and reaches only
the two public reads. There are no owner sessions, pairing codes or logout,
and no address, interface or header other than the token grants anything.
Which routes a product lists is the route gate, `access/routes.md`; roles
are core's [authorization](../../core/authorization.md).

## Story: Admit only the supervising host

> As the owner, I want only the host that launched my agent to use its
> local API, so that no other app on my device can read my conversations
> or act as me.

### Only the token of this launch makes a caller Root

The shell compares the presented token with the launch token in constant
time, and only the result of that comparison leaves the secret. A request
with no token, a wrong token or the token of an earlier launch is
`Anonymous`. The peer address is never an input: a loopback or socket peer
without the token is anonymous like any other.

```quint
import authorization as Z from "../../core/authorization"
import launch as L from "../host/launch"
import routes as R from "./routes"
type Caller = Root | Anonymous
pure def declassifyTokenMatches(launchToken: L::SecretLaunchToken, presented: L::SecretLaunchToken): bool =
  launchToken != "" and presented == launchToken
pure def callerOf(launchToken: L::SecretLaunchToken, presented: L::SecretLaunchToken): Caller =
  if (declassifyTokenMatches(launchToken, presented)) Root else Anonymous
pure val launchTokenValues = Set("", "k1")
pure val presentedValues = Set("", "k1", "k2")
pure def lawNoTokenIsNeverRoot(launchToken: L::SecretLaunchToken): bool = callerOf(launchToken, "") == Anonymous
```

### Only the agent's own health and auth status reads are public

`GET /api/health` and `GET /api/auth/status`, as the agent itself
registers them, are `Public`. Every other route is `RootOnly`, and a route
a plugin registers is `RootOnly` whatever class it declares: no plugin can
lower a route below Root. Methods are the route gate's.

```quint
type AccessClass = Public | RootOnly
type RouteOrigin = Builtin | FromPlugin({ declared: AccessClass })
type RouteKey = { verb: R::Method, path: str, origin: RouteOrigin }
pure def publicPath(path: str): bool = path == "/api/health" or path == "/api/auth/status"
pure def accessClass(r: RouteKey): AccessClass =
  if (r.origin == Builtin and r.verb == R::Get and publicPath(r.path)) Public else RootOnly
pure val rValues = Set(
  { verb: R::Get, path: "/api/health", origin: Builtin },
  { verb: R::Get, path: "/api/auth/status", origin: FromPlugin({ declared: Public }) },
  { verb: R::Post, path: "/api/auth/status", origin: Builtin },
  { verb: R::Get, path: "/api/auth/me", origin: Builtin },
  { verb: R::Get, path: "/api/plugin/x", origin: FromPlugin({ declared: Public }) },
  { verb: R::Post, path: "/api/conversations", origin: FromPlugin({ declared: RootOnly }) })
pure def lawPluginRouteIsRootOnlyWhateverItDeclares(r: RouteKey): bool = r.origin != Builtin implies accessClass(r) == RootOnly
```

### A Root-only route admits only a caller holding the launch token

An anonymous caller of a Root-only route is answered 401 before dispatch,
with no body beyond the error code. A refusal never grants access, and the
supervising host reaches every route.

```quint
type Entry = Allowed | Unauthorized
pure def entry(r: RouteKey, caller: Caller): Entry = if (accessClass(r) == Public or caller == Root) Allowed else Unauthorized
pure def lawAnonymousReachesOnlyTheTwoPublicReads(r: RouteKey, launchToken: L::SecretLaunchToken, presented: L::SecretLaunchToken): bool =
  entry(r, callerOf(launchToken, presented)) == Allowed implies
    ((r.origin == Builtin and r.verb == R::Get and publicPath(r.path)) or (launchToken != "" and presented == launchToken))
pure def lawSupervisingHostReachesEveryRoute(r: RouteKey, launchToken: L::SecretLaunchToken): bool =
  launchToken != "" implies entry(r, callerOf(launchToken, launchToken)) == Allowed
```

### Auth status tells any caller only whether it holds the token and which start it reached

`GET /api/auth/status` answers `{authenticated, serverInstanceId}`.
`serverInstanceId` is the per-start id `/api/status` also reports, so a
client can tell a restarted agent from the one it checked. Nothing else is
disclosed to an anonymous caller.

```quint
type AuthStatus = { authenticated: bool, serverInstanceId: str }
pure def authStatus(caller: Caller, serverInstanceId: str): AuthStatus = { authenticated: caller == Root, serverInstanceId: serverInstanceId }
```

### The Root caller is the local owner of this agent

`GET /api/auth/me` is Root-only and answers
`{identity: {kind: "owner", id: agentId}, access: {role: "OWNER", mode: "local"}}`,
where `agentId` is the identity the store keeps. The owner entity of the
agent holds core `Owner`. The token proves the host, not the speaker: the
principal of a chat turn holds the launch's `chatRole`, so a `ChatAsUser`
launch never speaks as the owner although its requests arrive as Root.

```quint
type OwnerIdentity = { kind: str, id: str }
type OwnerAccess = { role: Z::Role, mode: str }
type AuthMe = { identity: OwnerIdentity, access: OwnerAccess }
pure def authMe(agentId: str): AuthMe = { identity: { kind: "owner", id: agentId }, access: { role: Z::Owner, mode: "local" } }
pure def lawUserLaunchNeverSpeaksAsTheOwner(agentId: str): bool =
  Z::rank(L::chatRole(L::ChatAsUser)) < Z::rank(authMe(agentId).access.role)
```

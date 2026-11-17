# Local access

Who may call the agent's local API. The only device client is the
supervising host: the os bridge, which holds the per-launch token from the
launch frame and attaches it to every request as `Authorization: Bearer`.
Every other caller is anonymous and reaches only the two public reads.
There are no owner sessions, pairing codes or logout, and no address,
interface or header other than the token grants anything. Which routes a
product lists is the route gate, `access/routes.md`; roles are core's
[authorization](../../core/authorization.md).

## Story: Admit only the supervising host

> As the owner, I want only the host that launched my agent to use its
> local API, so that no other app on my device can read my conversations
> or act as me.

### Only the launch token makes a caller Root

The presented token is compared with the launch token in constant time,
and only the result of that comparison leaves the secret. A request with no
token, a wrong token or a token of an earlier launch is `Anonymous`. The
peer address is never an input: a loopback or socket peer without the token
is anonymous like any other.

```quint
import authorization as Z from "../../core/authorization"
type SecretToken = str
type Caller = Root | Anonymous
pure def declassifyTokenMatches(launch: SecretToken, presented: SecretToken): bool = launch != "" and presented == launch
pure def callerOf(launch: SecretToken, presented: SecretToken): Caller = if (declassifyTokenMatches(launch, presented)) Root else Anonymous
pure val launchValues = Set("", "k1")
pure val presentedValues = Set("", "k1", "k2")
pure def lawMissingTokenIsNeverRoot(launch: SecretToken): bool = callerOf(launch, "") == Anonymous
```

### Only the agent's health and auth status reads are public

`GET /api/health` and `GET /api/auth/status`, as the agent registers them,
are `Public`. Every other route, and every route a plugin registers
whatever it declares, is `RootOnly`.

```quint
type AccessClass = Public | RootOnly
type RouteOrigin = Builtin | Plugin
pure def accessClass(method: str, path: str, declaredBy: RouteOrigin): AccessClass =
  if (declaredBy == Builtin and method == "GET" and (path == "/api/health" or path == "/api/auth/status")) Public else RootOnly
pure val methodValues = Set("GET", "POST")
pure val pathValues = Set("/api/health", "/api/auth/status", "/api/auth/me", "/api/conversations")
```

### A Root-only route admits only a caller holding the launch token

An anonymous caller of a Root-only route is answered 401 before dispatch,
with no body beyond the error code. Refusal grants nothing: no plugin and
no peer address can open a route to a caller without the token.

```quint
type Admission = Admitted | Unauthorized
pure def admission(cls: AccessClass, caller: Caller): Admission = if (cls == Public or caller == Root) Admitted else Unauthorized
pure def lawOnlyTheLaunchTokenOpensARootRoute(method: str, path: str, declaredBy: RouteOrigin, launch: SecretToken, presented: SecretToken): bool = {
  val cls = accessClass(method, path, declaredBy)
  admission(cls, callerOf(launch, presented)) == Admitted implies
    ((declaredBy == Builtin and method == "GET" and cls == Public) or (launch != "" and presented == launch))
}
pure def lawEveryRouteAdmitsTheSupervisingHost(method: str, path: str, declaredBy: RouteOrigin, launch: SecretToken): bool =
  launch != "" implies admission(accessClass(method, path, declaredBy), callerOf(launch, launch)) == Admitted
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
agent holds core `Owner`.

```quint
type OwnerIdentity = { agentId: str }
pure val ownerRole: Z::Role = Z::Owner
```

### A chat message speaks with the launch's caller role, never above it

The token proves the host, not the speaker. The principal of a chat turn
holds the launch's `callerRole`, `Owner` or `User`; a `User` launch never
speaks as the owner, although its requests arrive as Root.

```quint
type CallerRole = OwnerCaller | UserCaller
pure def principalRole(callerRole: CallerRole): Z::Role = if (callerRole == OwnerCaller) Z::Owner else Z::User
pure def lawUserLaunchNeverSpeaksAsOwner(callerRole: CallerRole): bool =
  callerRole == UserCaller implies Z::rank(principalRole(callerRole)) < Z::rank(ownerRole)
```

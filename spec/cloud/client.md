# Cloud client

What `@elizaos/cloud/client` speaks: the device side of the cloud. The agent,
os and the apps around them call the cloud through one client created from
the API origin and a credential getter. The client never stores or clears a
credential: custody belongs to os (`spec/os/signIn/credential.md`). Sources
are develop `packages/cloud/sdk/src/` (`subscription-entitlement.ts`,
`cloud-account-billing.ts`, `account-billing-snapshot.ts`) and the Android
`CloudConnectionPolicy.java` route allowlist, which the table below replaces;
os `signIn/cloudRequests.md` imports that table instead of naming paths.

This library has no state. JSON, fetch, header values and the entitlement
signature stay in the shell (`src/client/`); the relay wire is
`./services/speechRelay`.

## Story: Use the cloud from the device as configured

> As a device owner, I want the agent on my device to reach the cloud with the
> credential I hold now, and to answer text as soon as it has that credential
> and the cloud's address, so that a renewed credential works at once and no
> other connection is needed first.

### The base URL is an origin and nothing more

A configured base URL is accepted only as an origin: `https`, or `http` on a
loopback host, with no path beyond `/`, no query and no fragment. A value
with a path such as `/api/v1` is refused when the client is created; every
route below carries its full path.

```quint
import types.* from "./shared/types"
import accounts as A from "./identity/accounts"
import plans as P from "./billing/plans"
import subscriptions as Sub from "./billing/subscriptions"
import metering as M from "./shared/metering"
type Scheme = Https | Http | OtherScheme
type BaseUrl = { scheme: Scheme, loopback: bool, hasPath: bool, hasQueryOrFragment: bool }
pure def originAccepted(u: BaseUrl): bool =
  not(u.hasPath) and not(u.hasQueryOrFragment) and (u.scheme == Https or (u.scheme == Http and u.loopback))
pure val uValues = Set(
  { scheme: Https, loopback: false, hasPath: false, hasQueryOrFragment: false },
  { scheme: Https, loopback: false, hasPath: true, hasQueryOrFragment: false },
  { scheme: Http, loopback: true, hasPath: false, hasQueryOrFragment: false },
  { scheme: Http, loopback: false, hasPath: false, hasQueryOrFragment: false },
  { scheme: OtherScheme, loopback: true, hasPath: false, hasQueryOrFragment: true })
pure def lawAPathIsRefused(u: BaseUrl): bool = u.hasPath implies not(originAccepted(u))
```

### Every call reads the credential when it is sent

The client holds a getter, not a credential. Each call reads it once, just
before sending, and sends `Authorization: Bearer <credential>`; a credential
that os replaced is sent on the next call by the same client.

```quint
type HttpMethod = Get | Post | Patch | Delete
type Segment = Literal({ text: str }) | Param({ name: str })
type AuthClass = Public | KeyOrSession | Mail | Session | SessionFamily | FreshSession | StepUp
type DeviceRoute = { method: HttpMethod, path: List[Segment], auth: AuthClass, headers: Set[str] }
type DeviceCall = { route: DeviceRoute, bearer: str }
pure def callOf(route: DeviceRoute, credentialNow: str): DeviceCall = { route: route, bearer: credentialNow }
pure def lawACallCarriesTheCredentialReadForIt(route: DeviceRoute, credentialNow: str): bool =
  callOf(route, credentialNow).bearer == credentialNow
pure val routeValues: Set[DeviceRoute] = Set({ method: Get, path: List(Literal({ text: "api" }), Literal({ text: "v1" }), Literal({ text: "models" })), auth: KeyOrSession, headers: Set("If-Match") })
```

### Text needs only a credential and the origin, and nothing needs managed Google

The capability flags are `text`, `speechIn` and `speechOut`. A flag the
owner turned on is available when the client has a credential and an
accepted origin. Managed Google is a separate connection: no flag waits for
it.

```quint
type CloudCapabilities = { text: bool, speechIn: bool, speechOut: bool }
type CloudSetup = { credential: bool, origin: bool, managedGoogle: bool }
pure def ready(setup: CloudSetup): bool = setup.credential and setup.origin
pure def availableCapabilities(setup: CloudSetup, wanted: CloudCapabilities): CloudCapabilities =
  { text: wanted.text and ready(setup), speechIn: wanted.speechIn and ready(setup), speechOut: wanted.speechOut and ready(setup) }
pure val setupValues = Set(
  { credential: true, origin: true, managedGoogle: false }, { credential: true, origin: true, managedGoogle: true },
  { credential: false, origin: true, managedGoogle: true }, { credential: true, origin: false, managedGoogle: true })
pure val wantedValues = Set(
  { text: true, speechIn: true, speechOut: true }, { text: true, speechIn: false, speechOut: false },
  { text: false, speechIn: true, speechOut: true })
pure def lawTextNeedsOnlyACredentialAndTheOrigin(setup: CloudSetup, wanted: CloudCapabilities): bool =
  availableCapabilities(setup, wanted).text iff (wanted.text and setup.credential and setup.origin)
pure def lawNoCapabilityNeedsManagedGoogle(setup: CloudSetup, wanted: CloudCapabilities): bool =
  availableCapabilities({ ...setup, managedGoogle: true }, wanted) == availableCapabilities({ ...setup, managedGoogle: false }, wanted)
```

### A device sends only the routes of one table, each with its own headers

`deviceRoutes` is every route a device may call. Every route admits
`Authorization`, `Content-Type`, `X-Request-ID`, `Traceparent` and
`Tracestate`; a route's `headers` names the others it admits:
`Idempotency-Key` on subscription checkout, redeem, chat completions,
every metered maps operation and calendar create, `If-Match` on calendar change and delete. The
auth classes are those of the cloud's request authentication. Enrollment
and confirmation use a signed session. Their handlers apply the
[second-factor policy](./identity/secondFactor.md) for a fresh first setup
or a recent step-up for later changes. A sign-in
route marked `Public` carries its proof in the body (code, verifier,
challenge or refresh token, or a device lease's refresh as its bearer).
`Mail` is Google mail and calendar: it admits a session or the tablet's
device lease and refuses the device key, so the native shell sends it with
the lease's access token. `SessionFamily` is logout: the handler checks
the presented access or refresh digest for the family it will end. The
speech socket carries the session token in its `hello`. Routes the cloud
calls itself, provider callbacks, the payment
webhook and the loopback test inbox are not device routes.

```quint
pure val idempotencyKey = "Idempotency-Key"
pure val ifMatch = "If-Match"
pure val baseHeaders = Set("Authorization", "Content-Type", "X-Request-ID", "Traceparent", "Tracestate")
pure def lits(names: List[str]): List[Segment] = names.listMap(n => Literal({ text: n }))
pure def api(names: List[str]): List[Segment] = List(Literal({ text: "api" }), Literal({ text: "v1" })).concat(lits(names))
pure def apiWith(names: List[str], rest: List[Segment]): List[Segment] = api(names).concat(rest)
pure def route(method: HttpMethod, path: List[Segment], auth: AuthClass): DeviceRoute = { method: method, path: path, auth: auth, headers: Set() }
pure def keyed(method: HttpMethod, path: List[Segment], headers: Set[str]): DeviceRoute = { method: method, path: path, auth: KeyOrSession, headers: headers }
pure def mailed(method: HttpMethod, path: List[Segment], headers: Set[str]): DeviceRoute = { method: method, path: path, auth: Mail, headers: headers }
pure def google(names: List[str]): List[Segment] = api(List("eliza", "google").concat(names))
pure val signInRoutes: List[DeviceRoute] = List(
  route(Get, lits(List("api", "public", "service")), Public),
  route(Get, api(List("auth", "methods")), Public),
  route(Post, api(List("auth", "email", "code", "send")), Public),
  route(Post, api(List("auth", "email", "code", "verify")), Public),
  route(Post, api(List("auth", "sms", "code", "send")), Public),
  route(Post, api(List("auth", "sms", "code", "verify")), Public),
  route(Get, api(List("auth", "google", "authorize")), Public),
  route(Post, api(List("auth", "google", "exchange")), Public),
  route(Post, api(List("auth", "google", "native", "challenge")), Public),
  route(Post, api(List("auth", "mfa", "complete")), Public),
  route(Post, api(List("auth", "mfa", "sms", "send")), Public),
  route(Post, api(List("auth", "refresh")), Public),
  route(Post, api(List("auth", "logout")), SessionFamily),
  route(Post, api(List("auth", "mfa", "step-up")), Session),
  route(Get, api(List("auth", "mfa")), Session),
  route(Post, api(List("auth", "mfa", "totp", "enroll")), Session),
  route(Post, api(List("auth", "mfa", "totp", "confirm")), Session),
  route(Post, api(List("auth", "mfa", "sms", "enroll")), Session),
  route(Post, api(List("auth", "mfa", "sms", "confirm")), Session),
  route(Delete, apiWith(List("auth", "mfa"), List(Param({ name: "factorId" }))), StepUp),
  route(Get, api(List("user", "methods")), Session),
  route(Post, api(List("user", "methods", "phone", "code", "send")), Session),
  route(Post, api(List("user", "methods", "phone", "code", "verify")), Session),
  route(Post, api(List("user", "methods", "google", "challenge")), Session),
  route(Post, api(List("user", "methods", "google", "link")), Session),
  route(Delete, apiWith(List("user", "methods"), List(Param({ name: "methodId" }))), StepUp),
  route(Get, api(List("user")), KeyOrSession),
  route(Get, api(List("referrals")), KeyOrSession),
  route(Post, api(List("referrals", "apply")), KeyOrSession),
  route(Get, api(List("app-auth", "mobile", "config")), Public),
  route(Post, api(List("app-auth", "connect")), Session),
  route(Post, api(List("app-auth", "mobile", "token")), Public),
  route(Post, api(List("app-auth", "mobile", "ack")), Public),
  route(Post, api(List("app-auth", "mobile", "google")), Public),
  route(Post, api(List("app-auth", "mobile", "lease")), Public),
  route(Delete, api(List("app-auth", "mobile", "lease")), Public),
  route(Post, api(List("app-auth", "mobile", "renew")), Public),

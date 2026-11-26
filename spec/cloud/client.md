# Cloud client

What the `@elizaos/cloud` root speaks: the device side of the cloud. The agent,
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
every metered maps operation and calendar create, `If-Match` on calendar change and delete,
`X-Renewed-Credential-Id` on the device key's sign-out. The
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
pure val renewedCredential = "X-Renewed-Credential-Id"
pure val baseHeaders = Set("Authorization", "Content-Type", "X-Request-ID", "Traceparent", "Tracestate")
pure def lits(names: List[str]): List[Segment] = names.listMap(n => Literal({ text: n }))
pure def api(names: List[str]): List[Segment] = List(Literal({ text: "api" }), Literal({ text: "v1" })).concat(lits(names))
pure def apiWith(names: List[str], rest: List[Segment]): List[Segment] = api(names).concat(rest)
pure def route(method: HttpMethod, path: List[Segment], auth: AuthClass): DeviceRoute = { method: method, path: path, auth: auth, headers: Set() }
pure def keyed(method: HttpMethod, path: List[Segment], headers: Set[str]): DeviceRoute = { method: method, path: path, auth: KeyOrSession, headers: headers }
pure def sessionHeaders(method: HttpMethod, path: List[Segment], headers: Set[str]): DeviceRoute = { method: method, path: path, auth: Session, headers: headers }
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
  route(Delete, api(List("api-keys", "current")), KeyOrSession))
pure val billingRoutes: List[DeviceRoute] = List(
  route(Get, api(List("subscriptions", "plans")), Public),
  route(Get, api(List("subscription", "entitlement-keys")), Public),
  route(Get, api(List("billing", "limits")), KeyOrSession),
  route(Get, api(List("subscription", "entitlement")), KeyOrSession),
  keyed(Post, api(List("subscription", "redeem")), Set("Idempotency-Key")),
  keyed(Post, api(List("subscriptions", "checkout")), Set("Idempotency-Key")),
  route(Post, api(List("subscriptions", "checkout", "confirm")), KeyOrSession),
  route(Post, api(List("subscriptions", "cancel")), FreshSession),
  route(Post, api(List("subscriptions", "cancel", "undo")), FreshSession),
  route(Get, apiWith(List("subscriptions", "cancel"), List(Param({ name: "commandId" }))), FreshSession),
  route(Get, apiWith(List("subscriptions", "cancel", "undo"), List(Param({ name: "commandId" }))), FreshSession),
  route(Get, api(List("subscriptions", "cancel", "undo", "review")), FreshSession),
  route(Post, api(List("subscriptions", "upgrade", "review")), FreshSession),
  route(Post, api(List("subscriptions", "upgrade", "confirm")), FreshSession),
  route(Post, api(List("subscriptions", "downgrade", "review")), FreshSession),
  route(Post, api(List("subscriptions", "downgrade", "confirm")), FreshSession),
  route(Get, apiWith(List("subscriptions", "upgrade"), List(Param({ name: "commandId" }))), FreshSession),
  route(Get, apiWith(List("subscriptions", "downgrade"), List(Param({ name: "commandId" }))), FreshSession),
  route(Post, apiWith(List("subscriptions", "upgrade"), List(Param({ name: "commandId" }), Literal({ text: "payment" }))), FreshSession),
  route(Get, api(List("subscriptions", "commands")), KeyOrSession),
  route(Post, api(List("subscriptions", "portal")), FreshSession),
  route(Get, api(List("billing", "invoices")), KeyOrSession),
  route(Get, apiWith(List("billing", "invoices"), List(Param({ name: "invoiceId" }))), KeyOrSession))
pure val serviceRoutes: List[DeviceRoute] = List(
  route(Get, api(List("models")), KeyOrSession),
  route(Post, api(List("decisions")), KeyOrSession),
  keyed(Post, api(List("chat", "completions")), Set(idempotencyKey)),
  route(Post, api(List("voice", "tts")), KeyOrSession),
  route(Post, api(List("voice", "stt")), KeyOrSession),
  route(Post, api(List("voice", "speech", "consent")), KeyOrSession),
  route(Post, api(List("voice", "speech", "session")), KeyOrSession),
  route(Get, api(List("voice", "speech", "ws")), Public),
  route(Post, apiWith(List("voice", "speech", "session"), List(Param({ name: "sessionId" }), Literal({ text: "revoke" }))), KeyOrSession),
  route(Get, api(List("maps", "capabilities")), KeyOrSession),
  keyed(Post, api(List("maps", "geocode")), Set("Idempotency-Key")),
  keyed(Post, api(List("maps", "reverse")), Set("Idempotency-Key")),
  keyed(Post, api(List("maps", "places", "search")), Set("Idempotency-Key")),
  keyed(Post, api(List("maps", "places", "details")), Set("Idempotency-Key")),
  keyed(Post, api(List("maps", "routes")), Set("Idempotency-Key")),
  route(Post, api(List("maps", "tiles", "viewport")), KeyOrSession),
  keyed(Get, apiWith(List("maps", "tiles"), List(Param({ name: "z" }), Param({ name: "x" }), Param({ name: "y" }))), Set("Idempotency-Key")))
pure val googleRoutes: List[DeviceRoute] = List(
  route(Get, google(List("status")), Mail),
  route(Get, google(List("accounts")), Mail),
  route(Post, google(List("connect", "initiate")), Session),
  route(Post, google(List("connect", "native")), KeyOrSession),
  route(Post, google(List("disconnect")), Session),
  route(Get, google(List("gmail", "triage")), Mail),
  route(Get, google(List("gmail", "search")), Mail),
  route(Get, google(List("gmail", "read")), Mail),
  route(Get, google(List("gmail", "inbox-v1", "arrival")), KeyOrSession),
  route(Get, google(List("gmail", "inbox-v1", "capabilities")), Mail),
  route(Get, google(List("gmail", "inbox-v1", "history")), Mail),
  route(Get, google(List("gmail", "inbox-v1", "thread")), Mail),
  route(Get, google(List("gmail", "inbox-v1", "attachment")), Mail),
  route(Get, google(List("gmail", "inbox-v1", "drafts")), Mail),
  route(Get, google(List("gmail", "inbox-v1", "draft")), Mail),
  route(Post, google(List("gmail", "inbox-v1", "operations")), Session),
  route(Post, google(List("gmail", "inbox-v1", "operations")).concat(List(Param({ name: "requestId" }), Literal({ text: "dispatch" }))), Session),
  route(Get, google(List("gmail", "inbox-v1", "operations")).concat(List(Param({ name: "requestId" }))), Session),
  route(Get, google(List("calendar", "calendars")), Mail),
  route(Get, google(List("calendar", "feed")), Mail),
  route(Get, google(List("calendar", "events")).concat(List(Param({ name: "eventId" }))), Mail),
  sessionHeaders(Post, google(List("calendar", "events")), Set("Idempotency-Key")),
  sessionHeaders(Patch, google(List("calendar", "events")).concat(List(Param({ name: "eventId" }))), Set("If-Match")),
  sessionHeaders(Delete, google(List("calendar", "events")).concat(List(Param({ name: "eventId" }))), Set("If-Match")))
pure def joinRouteGroups(earlier: List[DeviceRoute], later: List[DeviceRoute]): List[DeviceRoute] = earlier.concat(later)
pure val deviceRoutes: List[DeviceRoute] = joinRouteGroups(joinRouteGroups(signInRoutes, billingRoutes), joinRouteGroups(serviceRoutes, googleRoutes))
pure def admitsHeader(r: DeviceRoute, header: str): bool = baseHeaders.contains(header) or r.headers.contains(header)
pure def routesOf(method: HttpMethod): List[DeviceRoute] = deviceRoutes.select(d => d.method == method)
pure def lawEveryRouteIsUnderApi(method: HttpMethod): bool =
  routesOf(method).every(d => d.path.nthOr(0, Param({ name: "" })) == Literal({ text: "api" }))
pure def lawNoRouteIsListedTwice(method: HttpMethod): bool =
  routesOf(method).every(d => routesOf(method).select(other => other.path == d.path).length() == 1)
pure def lawIfMatchOnlyOnChangeAndDelete(method: HttpMethod): bool =
  (method == Get or method == Post) implies routesOf(method).every(d => not(d.headers.contains(ifMatch)))
```

### A request path matches the listed route with the most literal segments

A request matches a route of the same method whose segments match one to
one: a literal equals its part, a parameter takes any non-empty part. When
two routes match, as `/cancel/undo/review` and `/cancel/undo/:commandId` do,
the one with more literal segments wins. A path no route matches is not
sent.

```quint
type RouteLookup = Unlisted | Listed({ route: DeviceRoute })
pure def segmentMatches(seg: Segment, part: str): bool = match seg { | Literal(l) => l.text == part | Param(p) => part != "" }
pure def routeMatches(r: DeviceRoute, method: HttpMethod, parts: List[str]): bool = {
  val matched = parts.foldl(0, (n, part) => if (n >= 0 and segmentMatches(r.path.nthOr(n, Literal({ text: "" })), part)) n + 1 else -1)
  r.method == method and r.path.length() == parts.length() and matched == parts.length()
}
pure def literalCount(r: DeviceRoute): int = r.path.select(seg => match seg { | Literal(l) => true | Param(p) => false }).length()
pure def routeFor(method: HttpMethod, parts: List[str]): RouteLookup =
  deviceRoutes.foldl(Unlisted, (best, r) =>
    if (not(routeMatches(r, method, parts))) best
    else match best { | Unlisted => Listed({ route: r }) | Listed(b) => if (literalCount(r) > literalCount(b.route)) Listed({ route: r }) else best })
pure val partsValues = Set(
  List("api", "v1", "subscriptions", "cancel", "undo", "review"), List("api", "v1", "subscriptions", "cancel", "undo", "cmd_1"),
  List("api", "v1", "models"), List("api", "v1", "agents"), List("api", "v1", "billing", "invoices", ""))
pure def lawAMatchedRouteMatches(method: HttpMethod, parts: List[str]): bool = {
  val found = routeFor(method, parts)
  match found {
    | Listed(x) => routeMatches(x.route, method, parts)
    | Unlisted => deviceRoutes.select(r => routeMatches(r, method, parts)).length() == 0
  }
}
```

## Story: Tell an account that needs attention from a failing service

> As a device owner, I want a refusal from the cloud told as what I can do
> about it, an expired credential, no credits, a spent allowance, a wait, a
> missing consent or an outage, so that I fix my account only when my
> account is the problem.

### Every refusal reads as one CloudError and none touches the credential

The shell reads the refusal body (`{error, errorDescription, retryable,
retryAt?, resetsAt?, reason?}`) and passes its code, reason and times
(epoch milliseconds, `0` when absent; a `Retry-After` header gives `retryAt`
when the body has none). A body that is not a refusal body is read as the
default code of its status. A failure before any answer is
`CloudNetwork`, carrying what the fetch rejected with. The variants are those of the agent's model binding, plus
the credential reason and `CloudRefused` for a refusal that needs the
request or the person to change. Every `401` is `CloudCredentialInvalid`
with its credential reason; reading an error never stores or clears a
credential.

```quint
type CloudError =
  CloudCredentialInvalid({ reason: RefusalReason }) | CloudInsufficientCredits | CloudAllowanceExhausted({ resetsAt: Millis })
  | CloudRateLimited({ retryAt: Millis }) | CloudConsentRequired | CloudUnavailable({ retryAfter: Millis })
  | CloudProviderIssue | CloudNetwork | CloudRefused({ code: RefusalCode, reason: RefusalReason })
pure def credentialReasonOf(reason: RefusalReason): RefusalReason = if (isCredentialReason(reason)) reason else CredentialUnknown
pure def defaultCodeOf(status: int): RefusalCode =
  if (status == 401) AuthenticationRequired
  else if (status == 402) InsufficientCredits
  else if (status == 403) AccessDenied
  else if (status == 404) NotFound
  else if (status == 429) RateLimited
  else if (status == 502) ProviderInvalidResponse
  else if (status >= 500) ServiceUnavailable
  else InvalidRequest
pure def cloudErrorOf(status: int, code: RefusalCode, reason: RefusalReason, retryAt: Millis, resetsAt: Millis): CloudError =
  if (status == 401) CloudCredentialInvalid({ reason: credentialReasonOf(reason) })
  else if (status == 402) (if (code == AllowanceExhausted) CloudAllowanceExhausted({ resetsAt: resetsAt }) else CloudInsufficientCredits)
  else if (status == 429) CloudRateLimited({ retryAt: retryAt })
  else if (code == SpeechConsentRequired) CloudConsentRequired
  else if (status == 502) CloudProviderIssue
  else if (status == 503 and reason == GoogleNotConfigured) CloudRefused({ code: code, reason: reason })
  else if (status >= 500) CloudUnavailable({ retryAfter: retryAt })
  else CloudRefused({ code: code, reason: reason })
type CustodyEffect = KeepsCredential | ClearsCredential
pure def custodyAfter(e: CloudError): CustodyEffect = KeepsCredential
pure val eValues = Set(CloudCredentialInvalid({ reason: CredentialExpired }), CloudInsufficientCredits, CloudAllowanceExhausted({ resetsAt: 10 }),
  CloudRateLimited({ retryAt: 5 }), CloudRateLimited({ retryAt: 20 }), CloudConsentRequired, CloudUnavailable({ retryAfter: 5 }),
  CloudProviderIssue, CloudNetwork, CloudRefused({ code: NotFound, reason: NoReason }))
pure val statusValues = Set(400, 401, 402, 403, 404, 409, 428, 429, 500, 502, 503)
pure def lawEvery401IsCredentialInvalid(status: int, code: RefusalCode, reason: RefusalReason, retryAt: Millis, resetsAt: Millis): bool =
  status == 401 implies cloudErrorOf(status, code, reason, retryAt, resetsAt) == CloudCredentialInvalid({ reason: credentialReasonOf(reason) })
pure def lawACredentialReasonIsKept(reason: RefusalReason): bool = isCredentialReason(reason) implies credentialReasonOf(reason) == reason
pure def lawNothingClearsCustody(e: CloudError): bool = custodyAfter(e) == KeepsCredential
pure def namesTheCredential(e: CloudError): bool = match e { | CloudCredentialInvalid(c) => true | _ => false }
pure def lawOnlyA401NamesTheCredential(status: int, code: RefusalCode, reason: RefusalReason, retryAt: Millis, resetsAt: Millis): bool =
  namesTheCredential(cloudErrorOf(status, code, reason, retryAt, resetsAt)) iff status == 401
pure def lawAWellFormedRefusalKeepsItsWait(code: RefusalCode, at: Millis): bool =
  (code == AllowanceExhausted implies cloudErrorOf(statusOf(code), code, NoReason, 0, at) == CloudAllowanceExhausted({ resetsAt: at }))
  and (code == RateLimited implies cloudErrorOf(statusOf(code), code, NoReason, at, 0) == CloudRateLimited({ retryAt: at }))
```

### An entitlement is refreshed five minutes before it expires, and backs off after a failure

With no failure the next refresh is five minutes before expiry, never sooner
than the first retry step, so a token the cloud answers again unchanged never
makes the client spin. After `n` failures in a row the delay is the `n`th
step of 5, 10, 20, 40, 80, 160 and 300 seconds, then 300 seconds.

```quint
pure val refreshLead: Millis = 5 * millisPerMinute
pure val refreshRetrySteps: List[Millis] = List(5000, 10000, 20000, 40000, 80000, 160000, 300000)
pure val refreshRetryMax: Millis = 300000
pure def nextRefreshDelay(untilExpiry: Millis, failures: int): Millis =
  if (failures > 0) refreshRetrySteps.nthOr(failures - 1, refreshRetryMax)
  else if (untilExpiry - refreshLead > refreshRetrySteps.nthOr(0, refreshRetryMax)) untilExpiry - refreshLead
  else refreshRetrySteps.nthOr(0, refreshRetryMax)
pure val failuresValues = Set(0, 1, 2, 7, 8, 20)
pure def lawRefreshNeverSpins(untilExpiry: Millis, failures: int): bool = nextRefreshDelay(untilExpiry, failures) >= 5000
pure def lawBackoffIsBounded(untilExpiry: Millis, failures: int): bool = failures > 0 implies nextRefreshDelay(untilExpiry, failures) <= refreshRetryMax
pure def lawRefreshLeadsExpiry(untilExpiry: Millis): bool =
  untilExpiry > refreshLead + 5000 implies nextRefreshDelay(untilExpiry, 0) == untilExpiry - refreshLead
```

### An account is usable when it is active, funded and its lane is open

The device reads the billing snapshot (`GET /api/v1/billing/limits`) as this
view. The account is usable for inference when it is Active, its inference
funding lane (`./shared/metering`) is not refused and its allowance plus its balance is above zero. A
free plan with credits is billed per request; a paid plan from a
subscription or a grant shows its key, with a warning while payment is
late; a free plan with no credits needs a plan. An unread or unreadable
snapshot admits nothing yet.

```quint
type PlanSource = FromSubscription | FromGrant | FromFree
type SnapshotView = { accountStatus: A::AccountStatus, balance: Micros, planKey: P::PlanKey, source: PlanSource, subscription: Sub::SubscriptionStatus, allowanceAvailable: Micros, inference: M::FundingLane, observedAt: Millis }
type PlanView = PlanChecking | PlanUnavailable | PlanOnCredits | PlanPaid({ planKey: P::PlanKey, warning: bool }) | PlanNone
type PlanAdmission = Admit | AdmitWithWarning | NeedsPlan | AdmissionUnknown
pure def accountUsable(s: SnapshotView): bool = s.accountStatus == A::Active and s.inference != M::Refused and s.allowanceAvailable + s.balance > 0
pure def paymentLate(subscription: Sub::SubscriptionStatus): bool = Set(Sub::Dunning, Sub::PastDue, Sub::Unpaid).contains(subscription)
pure def planFromSnapshot(s: SnapshotView): PlanView =
  if (s.source == FromFree) (if (s.balance > 0) PlanOnCredits else PlanNone)
  else PlanPaid({ planKey: s.planKey, warning: s.source == FromSubscription and paymentLate(s.subscription) })
pure def planAdmission(v: PlanView): PlanAdmission = match v {
  | PlanChecking => AdmissionUnknown
  | PlanUnavailable => AdmissionUnknown
  | PlanOnCredits => Admit
  | PlanPaid(p) => if (p.warning) AdmitWithWarning else Admit
  | PlanNone => NeedsPlan
}
pure val sValues = Set(
  { accountStatus: A::Active, balance: 0, planKey: P::Free, source: FromFree, subscription: Sub::NoSubscription, allowanceAvailable: 0, inference: M::CreditsOnly, observedAt: 1 },
  { accountStatus: A::Active, balance: 5, planKey: P::Free, source: FromFree, subscription: Sub::NoSubscription, allowanceAvailable: 0, inference: M::CreditsOnly, observedAt: 1 },
  { accountStatus: A::Active, balance: 0, planKey: P::PlusMonthly, source: FromSubscription, subscription: Sub::PastDue, allowanceAvailable: 10, inference: M::AllowanceThenCredits, observedAt: 1 },
  { accountStatus: A::Deleting, balance: 9, planKey: P::ProMonthly, source: FromGrant, subscription: Sub::NoSubscription, allowanceAvailable: 10, inference: M::AllowanceThenCredits, observedAt: 1 },
  { accountStatus: A::Active, balance: 9, planKey: P::Free, source: FromFree, subscription: Sub::NoSubscription, allowanceAvailable: 0, inference: M::Refused, observedAt: 1 })
pure val vValues = Set(PlanChecking, PlanUnavailable, PlanOnCredits, PlanPaid({ planKey: P::PlusMonthly, warning: true }), PlanPaid({ planKey: P::ProMonthly, warning: false }), PlanNone)
pure def lawAnUnfundedAccountIsNotUsable(s: SnapshotView): bool = s.allowanceAvailable + s.balance <= 0 implies not(accountUsable(s))
pure def lawOnlyAnActiveAccountIsUsable(s: SnapshotView): bool = accountUsable(s) implies s.accountStatus == A::Active
pure def lawNoPlanAndNoCreditsNeedsAPlan(s: SnapshotView): bool =
  (s.source == FromFree and s.balance <= 0) implies planAdmission(planFromSnapshot(s)) == NeedsPlan
pure def lawUnknownAdmitsNothing(v: PlanView): bool = (v == PlanChecking or v == PlanUnavailable) implies planAdmission(v) == AdmissionUnknown
```

### A balance shows only from a snapshot under five minutes old, and a grant has ended once revoked or past its end

The device shows the snapshot's balance only when the snapshot was observed
at most five minutes before now and at most one minute after it; otherwise
the balance is unavailable. A shown balance above zero is funded, else zero.
A grant in a snapshot has ended when it is revoked or its end is at or
before the later of the snapshot's time and now. A redeem answer whose grant has ended at the time it is read
is an ended grant, not a redemption.

```quint
type CreditView = CreditFunded({ usdMicros: Micros }) | CreditZero | CreditUnavailable
type GrantTerm = { revoked: bool, bounded: bool, until: Millis }
pure val creditMaxAge: Millis = 5 * millisPerMinute
pure val snapshotSkew: Millis = millisPerMinute
pure def creditOf(balance: Micros, observedAt: Millis, now: Millis): CreditView =
  if (observedAt > now + snapshotSkew or now - observedAt > creditMaxAge) CreditUnavailable
  else if (balance > 0) CreditFunded({ usdMicros: balance })
  else CreditZero
pure def grantEndedAt(g: GrantTerm, at: Millis): bool = g.revoked or (g.bounded and g.until <= at)
pure def grantEndedInSnapshot(g: GrantTerm, observedAt: Millis, now: Millis): bool = grantEndedAt(g, if (observedAt > now) observedAt else now)
pure val balanceValues = Set(-1, 0, 7)
pure val observedAtValues = Set(0, 299999, 300001, 360001)
pure val nowValues = Set(0, 300000, 300002, 600002)
pure val gValues = Set({ revoked: true, bounded: false, until: 0 }, { revoked: false, bounded: false, until: 0 }, { revoked: false, bounded: true, until: 300000 })
pure def lawAStaleBalanceIsUnavailable(balance: Micros, observedAt: Millis, now: Millis): bool =
  now - observedAt > creditMaxAge implies creditOf(balance, observedAt, now) == CreditUnavailable
pure def lawARecentBalanceIsShown(balance: Micros, observedAt: Millis, now: Millis): bool =
  (observedAt <= now and now - observedAt <= creditMaxAge) implies creditOf(balance, observedAt, now) != CreditUnavailable
pure def lawAGrantEndedNowHasEndedInTheSnapshot(g: GrantTerm, observedAt: Millis, now: Millis): bool =
  grantEndedAt(g, now) implies grantEndedInSnapshot(g, observedAt, now)
```

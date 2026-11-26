# Cloud requests

The `ElizaCloud` plugin: how a product's page reaches the cloud through the
device without ever holding the device key. The product hands the plugin
its cloud route table at load, in the form of `spec/agent/access/routes.md`;
every request is admitted by that gate, then sent by the native shell to the
deployment's API origin with the credential `./credential.md` holds. The
page names a path and a query, never a host. Which routes exist, their auth
classes and the headers each admits are `spec/cloud/client.md`'s
`deviceRoutes`; this spec decides only what the device may forward and with
which credential. Sockets, URL parsing, hashing, files and HTTP stay in the
Java shell; sources are develop's `CloudConnectionPolicy.java` and
`NativeAppRequestPolicy.java`, which this replaces.

## Story: Reach my account's cloud services without holding my key

> As the maker of a product page, I want to call my account's cloud services
> through the device, with my credential attached by the device and never
> shown to my page, so that a compromised page cannot take the key or reach
> any route my product did not list.

### A call tied to a device credential cannot use a different credential

The page can name the device credential identifier it obtained from the
current sign-in. The identifier is public to the page. A bound call uses
the credential the native shell actually captured, and only while its
identifier and version still match the active credential immediately
before dispatch. It cannot attach an account session, a mail lease or no
credential. A mismatch is refused before a request leaves the device.

```quint
pure def namedCredentialAllows(expected: str, captured: str, active: str, versionMatches: bool, keyAttached: bool): bool =
  expected == "" or (expected == captured and expected == active and versionMatches and keyAttached)
pure def lawNamedCredentialCannotCrossOwners(expected: str, captured: str, active: str, versionMatches: bool, keyAttached: bool): bool =
  expected != "" and namedCredentialAllows(expected, captured, active, versionMatches, keyAttached) implies
    expected == captured and expected == active and versionMatches and keyAttached
```

### A cloud table is loaded only when every route is a device route the page may use

A consumer table is refused whole when any of its routes is not, by method
and path template, an entry of the cloud client's device route table, when
any route streams, or when any route belongs to sign-in: the routes under
`/api/v1/auth/`, `/api/v1/app-auth/`, `/api/v1/api-keys/` and
`/api/public/`, and the speech session routes under
`/api/v1/voice/speech/`, are called only by `./credential.md`,
`./readiness.md` and the speech client. A refused table leaves the gate
admitting nothing (the route gate's own rule).

```quint
import types.* from "../../cloud/shared/types"
import credential as C from "./credential"
import routes as Routes from "../../agent/access/routes"
import client.* from "../../cloud/client"
pure def sameMethod(m: Routes::Method, sent: HttpMethod): bool =
  (m == Routes::Get and sent == Get) or (m == Routes::Post and sent == Post) or (m == Routes::Patch and sent == Patch) or (m == Routes::Delete and sent == Delete)
pure def samePiece(p: Routes::Piece, seg: Segment): bool = match seg {
  | Literal(l) => p == Routes::Literal({ text: l.text })
  | Param(x) => p == Routes::Param
}
pure def samePath(t: Routes::Route, d: DeviceRoute): bool =
  t.path.length() == d.path.length() and
    t.path.foldl(0, (matched, p) => if (matched >= 0 and samePiece(p, d.path.nthOr(matched, Param({ name: "" })))) matched + 1 else -1) == t.path.length()
pure def deviceRouteOf(t: Routes::Route): List[DeviceRoute] = deviceRoutes.select(d => sameMethod(t.method, d.method) and samePath(t, d))
pure def under(d: DeviceRoute, names: List[str]): bool =
  names.foldl({ at: 0, ok: true }, (c, n) => { at: c.at + 1, ok: c.ok and d.path.nthOr(c.at, Literal({ text: "" })) == Literal({ text: n }) }).ok
pure def signInOwned(d: DeviceRoute): bool =
  under(d, List("api", "v1", "auth")) or under(d, List("api", "v1", "app-auth")) or under(d, List("api", "v1", "api-keys"))
    or under(d, List("api", "public")) or under(d, List("api", "v1", "voice", "speech"))
pure def pageRoute(t: Routes::Route): bool =
  t.delivery == Routes::Buffered and deviceRouteOf(t).length() == 1 and not(deviceRouteOf(t).some(d => signInOwned(d)))
pure def cloudTableAccepted(routes: Routes::RouteList): bool = routes.every(g => g.routes.every(t => pageRoute(t)))
pure def loadCloudTable(gate: Routes::RouteGate, routes: Routes::RouteList): Routes::RouteGate =
  Routes::load(gate, if (cloudTableAccepted(routes)) routes else List())
pure def lawALoadedTableHoldsOnlyPageRoutes(routes: Routes::RouteList): bool =
  Routes::served(loadCloudTable(Routes::initial, routes).table).every(g => g.routes.every(t => pageRoute(t)))
pure def lawOneForeignRouteRefusesTheTable(routes: Routes::RouteList): bool =
  routes.some(g => g.routes.some(t => not(pageRoute(t)))) implies Routes::served(loadCloudTable(Routes::initial, routes).table) == List()
```

### A session-only route is sent only with a live account session, never with the device key

The credential follows the device route, never the page: a `Public` route
is sent bare. `Session`, `SessionFamily`, `FreshSession` and `StepUp` use
only the account session from reauthentication (at most an hour old,
`./credential.md`), after one shared refresh when its access token has
expired, and otherwise fail with `ReauthRequired`; a mail or calendar route
uses the lease (the next rule); every other route carries the active device
key, or fails with `SignInRequired` when there is none. The key, the lease
and the session token are attached natively and never reach the page.

```quint
type Holding = { key: int, sessionHeld: bool, sessionLive: bool, leaseHeld: bool, leaseLive: bool }
type Attach = Bare | WithKey({ version: int }) | WithSession({ version: int }) | WithLease({ version: int })
type CallRefusal = NoOrigin | NotListed | BodyTooLarge | HeaderRefused | SignInRequired | MailLeaseUpgradeRequired | ReauthRequired
type CallPlan = Send({ attach: Attach }) | RefreshSessionFirst | RefreshLeaseFirst | Refuse({ why: CallRefusal })
pure def holdingOf(c: C::DeviceCredential): Holding =
  { key: C::activeVersion(c), sessionHeld: c.session != C::NoSession, sessionLive: C::sessionUsable(c), leaseHeld: c.lease != C::NoLease, leaseLive: C::leaseUsable(c) }
pure def sessionOnly(auth: AuthClass): bool = auth == Session or auth == SessionFamily or auth == FreshSession or auth == StepUp
pure def attachFor(h: Holding, d: DeviceRoute): CallPlan =
  if (d.auth == Public) Send({ attach: Bare })
  else if (sessionOnly(d.auth)) (if (h.sessionLive) Send({ attach: WithSession({ version: h.key }) }) else if (h.sessionHeld) RefreshSessionFirst else Refuse({ why: ReauthRequired }))
  else if (mailRoute(d)) (if (h.leaseLive) Send({ attach: WithLease({ version: h.key }) }) else if (h.leaseHeld) RefreshLeaseFirst else Refuse({ why: if (h.key >= 1) MailLeaseUpgradeRequired else SignInRequired }))
  else if (h.key >= 1) Send({ attach: WithKey({ version: h.key }) })
  else Refuse({ why: SignInRequired })
pure val hValues = Set({ key: 0, sessionHeld: false, sessionLive: false, leaseHeld: false, leaseLive: false },
  { key: 1, sessionHeld: false, sessionLive: false, leaseHeld: false, leaseLive: false },
  { key: 2, sessionHeld: true, sessionLive: false, leaseHeld: true, leaseLive: false }, { key: 2, sessionHeld: true, sessionLive: true, leaseHeld: true, leaseLive: true })
pure def keyOf(a: Attach): int = match a { | WithKey(k) => k.version | _ => 0 }
pure def sentKey(p: CallPlan): int = match p { | Send(s) => keyOf(s.attach) | _ => 0 }
pure def lawASessionRouteNeverCarriesTheKey(h: Holding, d: DeviceRoute): bool = sessionOnly(d.auth) implies sentKey(attachFor(h, d)) == 0
pure def lawAKeyRouteWithoutAKeyIsNotSent(h: Holding, d: DeviceRoute): bool =
  (d.auth == KeyOrSession and h.key < 1) implies attachFor(h, d) == Refuse({ why: SignInRequired })
```

### A mail or calendar route is sent only with the lease, never with the device key

The agent holds the device key and reads untrusted mail, so the cloud
refuses that key on its mail routes (`spec/cloud/identity/requestAuth.md`,
`MailRoute`), and the device never sends it there. The mail routes are the
device routes the cloud's client lists as `Mail` (`spec/cloud/client.md`):
Google status, accounts, connect, disconnect, Gmail triage, search, read,
history, thread, capabilities, drafts, draft, attachment and operations, and
the calendar list, feed, event reads and event writes. They carry the lease's
access token after one shared refresh when necessary (`./credential.md`).
A device with an active key and no lease gets `MailLeaseUpgradeRequired`.
The native bridge returns `mail-lease-upgrade-required` before it sends the
request. The host can offer the user a one-time sign-in to the same account.

For a host reading Google connection status, the owner's Google accounts,
an inbox page, a message, the inbox's change history or a calendar window,
the native package offers a read-only `GET` bound to the owner and current
credential identity. It admits only the reads of `hostMailReads`, each a
`Mail` device route under `/api/v1/eliza/google/`, with at most the query
fields listed for it: `status` with none; `accounts` with `side`;
`gmail/triage` with `maxResults`, `folder`, `q`, `counts`, `pageToken` and
`grantId`; `gmail/read` with `messageId` and `grantId`;
`gmail/inbox-v1/history` with `grantId`, `startHistoryId`, `pageToken`,
`maxResults` and `side`; and `calendar/feed` with `timeMin`, `timeMax`,
`pageToken` and `grantId`. Any other path or query field is refused before a
request leaves the device, and the reply is dropped if that identity changes.
The host receives the reply and a non-secret scope, while lease credentials
stay native.
The existing key stays available for its usual routes while the user decides
or cancels. The page sends a new request after the sign-in. A device without
a live key or lease gets `SignInRequired`. If a refresh ends the lease, the
native shell uses the current key and lease state to choose the refusal.
The native one-tap connect and inbox arrival keep the device key. Only mail
routes carry the lease.

```quint
pure def mailRoute(d: DeviceRoute): bool = d.auth == Mail
pure def leaseOf(a: Attach): int = match a { | WithLease(l) => l.version | _ => 0 }
pure def sentLease(p: CallPlan): int = match p { | Send(s) => leaseOf(s.attach) | _ => 0 }
pure def lawAMailRouteNeverCarriesTheKey(h: Holding, d: DeviceRoute): bool = mailRoute(d) implies sentKey(attachFor(h, d)) == 0
pure def lawTheLeaseGoesOnlyToAMailRoute(h: Holding, d: DeviceRoute): bool = sentLease(attachFor(h, d)) >= 1 implies mailRoute(d)
pure def lawOnlyAMailRouteOnAnExistingKeyWithoutALeaseNeedsTheUpgrade(h: Holding, d: DeviceRoute): bool =
  (attachFor(h, d) == Refuse({ why: MailLeaseUpgradeRequired })) iff
    (mailRoute(d) and h.key >= 1 and not(h.leaseHeld or h.leaseLive))
type HostMailRead = { under: List[str], fields: Set[str] }
pure val hostMailReads: List[HostMailRead] = List(
  { under: List("status"), fields: Set() },
  { under: List("accounts"), fields: Set("side") },
  { under: List("gmail", "triage"), fields: Set("maxResults", "folder", "q", "counts", "pageToken", "grantId") },
  { under: List("gmail", "read"), fields: Set("messageId", "grantId") },
  { under: List("gmail", "inbox-v1", "history"), fields: Set("grantId", "startHistoryId", "pageToken", "maxResults", "side") },
  { under: List("calendar", "feed"), fields: Set("timeMin", "timeMax", "pageToken", "grantId") })
pure def hostMailReadAdmitted(readPath: List[str], readFields: List[str]): bool =
  hostMailReads.some(r => r.under == readPath and readFields.every(f => r.fields.contains(f)))
pure val readPathValues = Set(List(), List("status"), List("accounts"), List("gmail", "inbox-v1", "history"), List("gmail", "history"),
  List("gmail", "search"), List("gmail", "operations"), List("calendar", "feed"))
pure val readFieldsValues = Set(List(), List("side"), List("grantId", "startHistoryId", "pageToken", "maxResults", "side"),
  List("messageId", "grantId"), List("timeMin", "q"))
pure def lawAHostMailReadIsAMailRouteRead(readPath: List[str], readFields: List[str]): bool =
  hostMailReadAdmitted(readPath, readFields) implies deviceRoutes.some(d => d.method == Get and mailRoute(d) and d.path == google(readPath))
```

### A request is sent only to the deployment origin, admitted by the gate, with headers its route admits

The page's headers pass unchanged when each is one its device route admits
(the client's base headers, and `Idempotency-Key` or `If-Match` where the
route lists it), `Accept`, or `If-None-Match` on a read (the shell compares names without
case); `Authorization`
from the page, a cookie or any other header refuses the request, and
nothing is trimmed. A body over the route's limit is `BodyTooLarge`. The
reply's status, `ETag`, `Content-Type` and `Retry-After` return to the
page, so a `412` reaches the caller that sent `If-Match`.

```quint
pure val noDeviceRoute: DeviceRoute = { method: Get, path: List(), auth: Public, headers: Set() }
pure def headerAllowed(d: DeviceRoute, header: str): bool =
  header != "Authorization" and (admitsHeader(d, header) or header == "Accept" or (header == "If-None-Match" and d.method == Get))
pure def planRequest(routes: Routes::RouteList, h: Holding, origin: BaseUrl, request: Routes::Request, headers: List[str]): CallPlan = {
  val a = Routes::admission(routes, request)
  val found = deviceRouteOf(Routes::admittedRoute(a).nthOr(0, Routes::noTemplate))
  val d = found.nthOr(0, noDeviceRoute)
  if (not(originAccepted(origin))) Refuse({ why: NoOrigin })
  else if (a == Routes::TooLarge) Refuse({ why: BodyTooLarge })
  else if (Routes::admittedRoute(a).length() != 1 or found.length() != 1) Refuse({ why: NotListed })
  else if (not(headers.every(x => headerAllowed(d, x)))) Refuse({ why: HeaderRefused })
  else attachFor(h, d)
}
pure def refused(p: CallPlan): bool = match p { | Refuse(r) => true | _ => false }
pure def lawASentRequestIsAdmittedOnTheOrigin(routes: Routes::RouteList, h: Holding, origin: BaseUrl, request: Routes::Request, headers: List[str]): bool =
  not(refused(planRequest(routes, h, origin, request, headers))) implies
    (originAccepted(origin) and Routes::admittedRoute(Routes::admission(routes, request)).length() == 1 and not(headers.includes("Authorization")))
pure val originValues = Set({ scheme: Https, loopback: false, hasPath: false, hasQueryOrFragment: false }, { scheme: Https, loopback: false, hasPath: true, hasQueryOrFragment: false })
pure val headersValues = Set(List(), List("Idempotency-Key"), List("If-Match"), List("Authorization"), List("Accept", "If-None-Match"))
pure def at(names: List[str]): List[Routes::Piece] =
  List(Routes::Literal({ text: "api" }), Routes::Literal({ text: "v1" })).concat(names.listMap(n => Routes::Literal({ text: n })))
pure def seg(text: str): Routes::Segment = { text: text, fits: List() }
pure val routesValues = {
  val read = { method: Routes::Get, delivery: Routes::Buffered, path: at(List("user")), query: List(), limit: Routes::AnySize }
  val table = { prefixes: List(List("api", "v1")), id: "id", routes: List(read,
    { ...read, path: at(List("subscriptions", "plans")) },
    { ...read, method: Routes::Post, path: at(List("subscriptions", "cancel")), limit: Routes::AtMost({ bytes: 20 }) },
    { ...read, path: at(List("eliza", "google", "calendar", "feed")), query: List({ key: "timeMin", accepts: Routes::AnyValue }) },
    { ...read, method: Routes::Patch, path: at(List("eliza", "google", "calendar", "events")).append(Routes::Param), limit: Routes::AtMost({ bytes: 20 }) }) }
  Set(List(table), List({ ...table, routes: table.routes.append({ ...read, path: at(List("agents")) }) }),
    List({ ...table, routes: table.routes.append({ ...read, method: Routes::Post, path: at(List("auth", "refresh")) }) }))
}
pure val requestValues: Set[Routes::Request] = {
  val user = { method: Routes::Get, delivery: Routes::Buffered, segments: List(seg("api"), seg("v1"), seg("user")), query: List(), flaws: List(), body: Routes::NoBody }
  val cancel = { ...user, method: Routes::Post, segments: List(seg("api"), seg("v1"), seg("subscriptions"), seg("cancel")), body: Routes::JsonObject({ size: 5 }) }
  val calendar = List(seg("api"), seg("v1"), seg("eliza"), seg("google"), seg("calendar"))
  Set(user, cancel, { ...cancel, body: Routes::JsonObject({ size: 30 }) },
    { ...user, segments: calendar.append(seg("feed")), query: List({ key: "timeMin", value: "0", fits: List() }) },
    { ...cancel, method: Routes::Patch, segments: calendar.concat(List(seg("events"), { text: "e1", fits: List("id") })) },
    { ...user, segments: List(seg("api"), seg("v1"), seg("models")) })
}
```

### A 401 goes to the credential with its reason and is not retried

The page gets the refusal as the cloud gave it; the request is never sent
again with another credential. A `401` on a request sent with the device key
is reported to `./credential.md` as `rejected` for that key's version, as an
account read when the route was `GET /api/v1/user`, which alone may sign
out. A `401` on a request sent with the lease is reported as `leaseRejected`
for its access token, which only discards that token. A `401` on a request
sent with the account session drops that session only. A device-key request is
attached only with a positive credential version. Its attachment kind
determines where the refusal is reported.

```quint
type CredentialReport = NoReport | KeyRejected({ version: int, reason: RefusalReason, on: C::RejectedOn }) | LeaseRejected({ version: int, reason: RefusalReason }) | SessionRejected
pure def isAccountRead(d: DeviceRoute): bool = d.method == Get and d.path == api(List("user"))
pure def reportOf(attach: Attach, d: DeviceRoute, status: int, reason: RefusalReason): CredentialReport =
  if (status != 401) NoReport
  else match attach {
    | WithKey(k) => KeyRejected({ version: k.version, reason: credentialReasonOf(reason), on: if (isAccountRead(d)) C::AccountRead else C::OtherRequest })
    | WithSession(x) => SessionRejected
    | WithLease(l) => LeaseRejected({ version: l.version, reason: credentialReasonOf(reason) })
    | Bare => NoReport
  }
pure def isKeyReport(r: CredentialReport): bool = match r { | KeyRejected(k) => true | _ => false }
pure val attachValues = Set(Bare, WithKey({ version: 1 }), WithSession({ version: 1 }), WithLease({ version: 1 }))
pure val dValues = Set(noDeviceRoute, { method: Get, path: api(List("user")), auth: KeyOrSession, headers: Set() },
  { method: Get, path: google(List("calendar", "feed")), auth: Mail, headers: Set() },
  { method: Post, path: google(List("connect", "native")), auth: KeyOrSession, headers: Set() },
  { method: Get, path: api(List("auth", "mfa")), auth: Session, headers: Set() })
pure val reasonValues = Set(CredentialExpired, CredentialRevoked, CredentialUnknown, NoReason)
pure def lawOnlyA401WithACredentialIsReported(attach: Attach, d: DeviceRoute, status: int, reason: RefusalReason): bool =
  (reportOf(attach, d, status, reason) != NoReport) iff (status == 401 and attach != Bare)
pure def usesDeviceKey(attach: Attach): bool = match attach { | WithKey(k) => true | _ => false }
pure def lawASession401NeverReachesTheKey(attach: Attach, d: DeviceRoute, status: int, reason: RefusalReason): bool =
  isKeyReport(reportOf(attach, d, status, reason)) iff (status == 401 and usesDeviceKey(attach))
pure def lawARequestCarriesOnlyAPositiveKeyVersion(h: Holding, d: DeviceRoute): bool = {
  val plan = attachFor(h, d)
  match plan {
    | Send(s) => usesDeviceKey(s.attach) implies keyOf(s.attach) >= 1
    | _ => true
  }
}
```

### A cancel disconnects only the page's own call still in flight, which then settles once as cancelled

The page may name a call when it sends it; a name already in flight is
refused. Cancelling that name disconnects the call's connection, and the
call settles as `cancelled` even when an answer was already arriving, so a
cancelled call never resolves. A cancel of a name that is unknown, or of a
call that has settled, changes nothing. Source: develop's
`PendingRequests.java`.

```quint
type CallStatus = CallInFlight | CallCancelled | CallSettled
type PageCall = { name: str, status: CallStatus }
type CallEnd = AnsweredCall | CancelledCall | UnansweredCall
pure def cancelCall(calls: List[PageCall], name: str): List[PageCall] =
  calls.listMap(c => if (c.name == name and c.status == CallInFlight) { ...c, status: CallCancelled } else c)
pure def callEnd(pending: PageCall, answered: bool): CallEnd =
  if (pending.status == CallCancelled) CancelledCall else if (answered) AnsweredCall else UnansweredCall
pure def nameFree(calls: List[PageCall], name: str): bool = not(calls.some(c => c.name == name and c.status != CallSettled))
pure val nameValues = Set("a", "b")
pure val callsValues = Set(List(), List({ name: "a", status: CallInFlight }), List({ name: "a", status: CallSettled }, { name: "b", status: CallInFlight }))
pure val pendingValues = Set({ name: "a", status: CallInFlight }, { name: "a", status: CallCancelled }, { name: "a", status: CallSettled })
pure def lawACancelChangesOnlyItsOwnCallInFlight(calls: List[PageCall], name: str): bool = {
  val after = cancelCall(calls, name)
  after.select(c => c.name != name) == calls.select(c => c.name != name)
    and after.select(c => c.status == CallSettled) == calls.select(c => c.status == CallSettled)
    and not(after.some(c => c.name == name and c.status == CallInFlight))
}
pure def lawACancelledCallNeverResolves(pending: PageCall, answered: bool): bool =
  pending.status == CallCancelled implies callEnd(pending, answered) == CancelledCall
```

### A reply body up to 8 MiB returns inline, up to 64 MiB through a one-use cache grant, and a larger one is refused

Nothing is truncated and binary bodies pass unchanged. A body over 8 MiB is
written to the app cache under its SHA-256 and the page gets a grant that
reads it once; a body over 64 MiB is refused whole with `ReplyTooLarge`.

```quint
type BodyHandoff = InlineBody | CachedBody | ReplyTooLarge
pure val inlineLimit: int = 8388608
pure val replyLimit: int = 67108864
pure def handoffOf(bytes: int): BodyHandoff = if (bytes > replyLimit) ReplyTooLarge else if (bytes > inlineLimit) CachedBody else InlineBody
type Grant = { grant: str, digest: str }
type Redemption = { grants: List[Grant], read: List[Grant] }
pure def redeem(grants: List[Grant], grant: str): Redemption = { grants: grants.select(g => g.grant != grant), read: grants.select(g => g.grant == grant) }
pure val bytesValues = Set(0, 8388608, 8388609, 67108864, 67108865)
pure val grantsValues = Set(List(), List({ grant: "g1", digest: "d1" }), List({ grant: "g1", digest: "d1" }, { grant: "g2", digest: "d1" }))
pure val grantValues = Set("g1", "g2")
pure def lawOnlyAnOversizeBodyIsRefused(bytes: int): bool = (handoffOf(bytes) == ReplyTooLarge) iff bytes > replyLimit
pure def lawAGrantReadsOnce(grants: List[Grant], grant: str): bool = redeem(redeem(grants, grant).grants, grant).read == List()
```

### Only an HTTPS page on the web host or a listed payment or consent host opens, in the system browser

A link from a reply (a checkout, the billing portal, Google consent) opens
in the system browser only on `https`, the default port, no user info, and a
host equal to the deployment's web host or one of the fixed provider hosts.

```quint
type ExternalLink = { https: bool, host: str, defaultPort: bool, userInfo: bool }
pure val providerHosts: Set[str] = Set("checkout.stripe.com", "billing.stripe.com", "accounts.google.com")
pure def opensExternally(webHost: str, link: ExternalLink): bool =
  link.https and link.defaultPort and not(link.userInfo) and (link.host == webHost or providerHosts.contains(link.host))
pure val webHostValues = Set("web.cloud.test")
pure val linkValues = Set({ https: true, host: "billing.stripe.com", defaultPort: true, userInfo: false },
  { https: true, host: "billing.stripe.com.evil.test", defaultPort: true, userInfo: false }, { https: false, host: "web.cloud.test", defaultPort: true, userInfo: false })
pure def lawALinkOpensOnlyOnAListedHost(webHost: str, link: ExternalLink): bool =
  opensExternally(webHost, link) implies (link.host == webHost or providerHosts.contains(link.host))
```

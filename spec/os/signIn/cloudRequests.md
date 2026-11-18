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
import client as Cc from "../../cloud/client"
pure def sameMethod(m: Routes::Method, d: Cc::HttpMethod): bool =
  (m == Routes::Get and d == Cc::Get) or (m == Routes::Post and d == Cc::Post) or (m == Routes::Patch and d == Cc::Patch) or (m == Routes::Delete and d == Cc::Delete)
pure def samePiece(p: Routes::Piece, seg: Cc::Segment): bool = match seg {
  | Cc::Literal(l) => p == Routes::Literal({ text: l.text })
  | Cc::Param(x) => p == Routes::Param
}
type PathProgress = { at: int, ok: bool }
pure def samePath(t: Routes::Route, d: Cc::DeviceRoute): bool =
  t.path.length() == d.path.length() and
    t.path.foldl({ at: 0, ok: true }, (c, p) => { at: c.at + 1, ok: c.ok and samePiece(p, d.path.nthOr(c.at, Cc::Param({ name: "" }))) }).ok
pure def deviceRouteOf(t: Routes::Route): List[Cc::DeviceRoute] = Cc::deviceRoutes.select(d => sameMethod(t.method, d.method) and samePath(t, d))
pure def lit(text: str): Cc::Segment = Cc::Literal({ text: text })
pure def under(d: Cc::DeviceRoute, names: List[str]): bool =
  names.foldl({ at: 0, ok: true }, (c, n) => { at: c.at + 1, ok: c.ok and d.path.nthOr(c.at, lit("")) == lit(n) }).ok
pure def signInOwned(d: Cc::DeviceRoute): bool =
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

The credential follows the device route's auth class, never the page: a
`Public` route is sent bare; a `Session`, `FreshSession` or `StepUp` route
only with the account session from reauthentication (at most an hour old,
`./credential.md`), after one shared refresh when its access token has
expired, and otherwise fails with `ReauthRequired`; every other route
carries the active device key, or fails with `SignInRequired` when there is
none. The key and the session token are attached natively and never reach
the page.

```quint
type Holding = { key: int, sessionHeld: bool, sessionLive: bool }
type Attach = Bare | WithKey({ version: int }) | WithSession({ version: int })
type CallRefusal = NoOrigin | NotListed | BodyTooLarge | HeaderRefused | SignInRequired | ReauthRequired
type CallPlan = Send({ attach: Attach }) | RefreshSessionFirst | Refuse({ why: CallRefusal })
pure def holdingOf(c: C::DeviceCredential): Holding =
  { key: C::activeVersion(c), sessionHeld: c.session != C::NoSession, sessionLive: C::sessionUsable(c) }
pure def sessionOnly(auth: Cc::AuthClass): bool = auth == Cc::Session or auth == Cc::FreshSession or auth == Cc::StepUp
pure def attachFor(h: Holding, auth: Cc::AuthClass): CallPlan =
  if (auth == Cc::Public) Send({ attach: Bare })
  else if (sessionOnly(auth)) (if (h.sessionLive) Send({ attach: WithSession({ version: h.key }) }) else if (h.sessionHeld) RefreshSessionFirst else Refuse({ why: ReauthRequired }))
  else if (h.key >= 1) Send({ attach: WithKey({ version: h.key }) })
  else Refuse({ why: SignInRequired })
pure val hValues = Set({ key: 0, sessionHeld: false, sessionLive: false }, { key: 1, sessionHeld: false, sessionLive: false },
  { key: 2, sessionHeld: true, sessionLive: false }, { key: 2, sessionHeld: true, sessionLive: true })
pure val authValues = Set(Cc::Public, Cc::KeyOrSession, Cc::Session, Cc::FreshSession, Cc::StepUp)
pure def carriesKey(p: CallPlan): bool = match p { | Send(s) => s.attach != Bare and s.attach == WithKey({ version: s.attach_version_unused }) | _ => false }
pure def lawASessionRouteNeverCarriesTheKey(h: Holding, auth: Cc::AuthClass): bool =
  sessionOnly(auth) implies not(attachFor(h, auth) == Send({ attach: WithKey({ version: h.key }) }))
pure def lawAKeyRouteWithoutAKeyIsNotSent(h: Holding, auth: Cc::AuthClass): bool =
  (auth == Cc::KeyOrSession and h.key < 1) implies attachFor(h, auth) == Refuse({ why: SignInRequired })
```

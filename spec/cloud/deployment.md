# Deployment profile

One reviewed profile describes a deployment of the cloud: its production and
staging environments, the callers each one answers, the capabilities it
enables, the sign-in methods it offers and the public documents it serves.
One instance serves the one environment it was started with, and it starts
only when the profile, the database and the payment provider's catalog all
agree with it. Sources are develop `packages/cloud/deploy/src`,
`shared/src/lib/services/subscription-catalog.ts` (`verifyPlan`),
`shared/src/lib/cors/` and `api/src/public/service/route.ts`; downstream
readers are the products' deployment scripts, readiness checks and the
service-information parser.

This library has no state. The profile's Effect Schema
(`src/profile/profile.schema.ts`) owns every string format (an origin is
HTTPS with no path or credentials; a display name has 1 to 80 characters and
no control character) and names the secrets read from the environment; no
rule sees a secret.

## Story: Configure a deployment from one reviewed profile

> As the operator of a deployment, I want to describe production and staging
> once and start each instance from that description, so that no instance
> trusts an authority, a database or a price the profile does not name.

### A profile is accepted only when its two environments share no origin or database, production uses no loopback adapter, and each environment offers a sign-in method and complete documents

Each environment names its display name, API and web origins, entitlement
audience, mail sender, expected database identity digest, exact first-party
origins, enabled capabilities, sign-in adapters and legal documents. There is
no tenant, no third origin and no credential namespace. The four API and web
origins are all different, and neither environment lists an origin of the
other as first party. Each display name is not empty, and each terms and
privacy document has a title, a revision and at least one section, each
section a title and at least one paragraph, none of them empty. Mail goes
out through an HTTPS provider, through a Worker's named send-email binding,
or to the loopback inbox; a binding is not loopback, and `serve`, which has
no bindings, refuses to start with one, as for a missing secret.

The profile's schema composes the parts other specs own and read from it:
the models and their prices (`services/models`), the maps provider
(`services/maps`; the `maps` capability is on exactly when the provider is
not `none`), the SMS countries (`identity/codeChallenges`), the Google client
ids (`nativeClients/registry`, `identity/federatedSignIn`), the provider base
URLs, and each paid plan's provider price and product id, which the catalog
check below reads.

```quint
import types.* from "./shared/types"
import plans.* from "./billing/plans"
type Environment = Production | Staging
type Capability = InferenceCapability | SpeechCapability | MapsCapability | ManagedGoogleCapability | BillingCapability
type DeliveryAdapter = HttpsDelivery | BindingDelivery | LoopbackDelivery | NoDelivery
type GoogleSetup = GoogleOff | GoogleOn
type SignInSetup = { mail: DeliveryAdapter, sms: DeliveryAdapter, google: GoogleSetup }
type DocumentSection = { title: str, paragraphs: List[str] }
type LegalDocument = { title: str, revision: str, sections: List[DocumentSection] }
type EnvironmentProfile = { name: str, api: str, web: str, audience: str, mailSender: str, databaseDigest: str, firstPartyOrigins: List[str], capabilities: Set[Capability], signIn: SignInSetup, terms: LegalDocument, privacy: LegalDocument }
type Profile = { production: EnvironmentProfile, staging: EnvironmentProfile }
pure def rowOf(p: Profile, environment: Environment): EnvironmentProfile = if (environment == Production) p.production else p.staging
pure def otherEnvironment(environment: Environment): Environment = if (environment == Production) Staging else Production
pure def usesLoopback(row: EnvironmentProfile): bool = row.signIn.mail == LoopbackDelivery or row.signIn.sms == LoopbackDelivery
pure def someMethodOffered(setup: SignInSetup): bool = setup.mail != NoDelivery or setup.sms != NoDelivery or setup.google == GoogleOn
pure def documentComplete(d: LegalDocument): bool =
  d.title != "" and d.revision != "" and d.sections.length() > 0
  and d.sections.every(x => x.title != "" and x.paragraphs.length() > 0 and x.paragraphs.every(t => t != ""))
pure def environmentAccepted(row: EnvironmentProfile, other: EnvironmentProfile): bool =
  row.name != "" and not(row.firstPartyOrigins.includes(other.api)) and not(row.firstPartyOrigins.includes(other.web))
  and someMethodOffered(row.signIn) and documentComplete(row.terms) and documentComplete(row.privacy)
pure def profileAccepted(p: Profile): bool = {
  val a = p.production
  val b = p.staging
  a.api != a.web and a.api != b.api and a.api != b.web and a.web != b.api and a.web != b.web and b.api != b.web
  and a.databaseDigest != b.databaseDigest and not(usesLoopback(a))
  and environmentAccepted(a, b) and environmentAccepted(b, a)
}
pure val pValues: Set[Profile] = {
  val doc: LegalDocument = { title: "Terms", revision: "1", sections: List({ title: "Use", paragraphs: List("Plain text.") }) }
  val prod: EnvironmentProfile = { name: "Cloud", api: "https://api.one", web: "https://www.one", audience: "aud", mailSender: "m@one", databaseDigest: "d1", firstPartyOrigins: List("https://www.one"), capabilities: Set(InferenceCapability, SpeechCapability, MapsCapability, ManagedGoogleCapability, BillingCapability), signIn: { mail: HttpsDelivery, sms: HttpsDelivery, google: GoogleOn }, terms: doc, privacy: doc }
  val stag: EnvironmentProfile = { ...prod, api: "https://api.two", web: "https://www.two", databaseDigest: "d2", firstPartyOrigins: List("https://www.two"), capabilities: Set(InferenceCapability), signIn: { mail: LoopbackDelivery, sms: LoopbackDelivery, google: GoogleOff } }
  Set({ production: prod, staging: stag })
    .union(Set({ production: prod, staging: { ...stag, databaseDigest: "d1" } }))
    .union(Set({ production: prod, staging: { ...stag, api: "https://api.one" } }))
    .union(Set({ production: prod, staging: { ...stag, web: "https://api.one" } }))
    .union(Set({ production: prod, staging: { ...stag, firstPartyOrigins: List("https://www.one") } }))
    .union(Set({ production: prod, staging: { ...stag, firstPartyOrigins: List("https://api.one") } }))
    .union(Set({ production: { ...prod, signIn: { mail: HttpsDelivery, sms: LoopbackDelivery, google: GoogleOn } }, staging: stag }))
    .union(Set({ production: { ...prod, signIn: { mail: BindingDelivery, sms: NoDelivery, google: GoogleOff } }, staging: stag }))
    .union(Set({ production: prod, staging: { ...stag, signIn: { mail: NoDelivery, sms: NoDelivery, google: GoogleOff } } }))
    .union(Set({ production: { ...prod, terms: { ...doc, sections: List() } }, staging: stag }))
    .union(Set({ production: { ...prod, name: "" }, staging: stag }))
}
```

### An instance starts only for an accepted profile, on its environment's own readable database, seeded only in staging, with loopback delivery only on PGlite

`elizaos-cloud serve --environment <e>` refuses to start, naming the first
problem in this order. The shell reads the connected database's identity
digest as `operator` describes; an identity it cannot read and another
database's identity are distinct problems. `--seed` (registrations and
prices) is refused outside staging. With billing enabled, the payment catalog
must also fit (next rule).

```quint
type StoreKind = PostgresStore | PgliteStore
type StoreIdentity = MatchingDatabase | OtherDatabase | UnreadableDatabase
type IdentityRead = UnreadableIdentity | ReadDigest({ digest: str })
type StartProblem = NoProblem | ProfileRefused | DatabaseUnreadable | DatabaseMismatch | SeedOutsideStaging | LoopbackOutsidePglite | CatalogMissing | CatalogMismatch({ plan: PlanKey, mismatch: PriceMismatch })
pure def identityOf(p: Profile, environment: Environment, read: IdentityRead): StoreIdentity = match read {
  | ReadDigest(r) => if (r.digest == rowOf(p, environment).databaseDigest) MatchingDatabase else OtherDatabase
  | UnreadableIdentity => UnreadableDatabase
}
pure def loopbackAllowed(store: StoreKind): bool = store == PgliteStore
pure def startProblem(p: Profile, environment: Environment, store: StoreKind, read: IdentityRead, seeded: bool, catalog: CatalogObservation): StartProblem = {
  val row = rowOf(p, environment)
  val identity = identityOf(p, environment, read)
  if (not(profileAccepted(p))) ProfileRefused
  else if (identity == UnreadableDatabase) DatabaseUnreadable
  else if (identity == OtherDatabase) DatabaseMismatch
  else if (seeded and environment != Staging) SeedOutsideStaging
  else if (usesLoopback(row) and not(loopbackAllowed(store))) LoopbackOutsidePglite
  else if (row.capabilities.contains(BillingCapability)) catalogProblem(environment, catalog)
  else NoProblem
}
pure def canServe(p: Profile, environment: Environment, store: StoreKind, read: IdentityRead, seeded: bool, catalog: CatalogObservation): bool = startProblem(p, environment, store, read, seeded, catalog) == NoProblem
pure val readValues: Set[IdentityRead] = Set(UnreadableIdentity, ReadDigest({ digest: "d1" }), ReadDigest({ digest: "d2" }), ReadDigest({ digest: "d3" }))
pure def lawAnInstanceNeverOpensTheOtherEnvironmentsDatabase(p: Profile, environment: Environment, store: StoreKind, read: IdentityRead, seeded: bool, catalog: CatalogObservation): bool =
  canServe(p, environment, store, read, seeded, catalog) implies read != ReadDigest({ digest: rowOf(p, otherEnvironment(environment)).databaseDigest })
```

### Each paid plan's provider price must be active, in US dollars, the catalog amount, monthly, licensed, without trial, on its product and in the environment's mode

The check runs at `serve` start and in `elizaos-cloud prices check`. A billing
profile configures a price and product for Plus and may configure a second
pair for Pro. The shell reads every configured price and product from the provider
and reports any currency option other than US dollars as `OtherCurrency`;
recurrence fits only for one month, per unit and no quantity transform.
Production sells only live prices and staging only test prices. Any mismatch
refuses the start; every configured pair must be verified.

```quint
type PriceCurrency = Usd | OtherCurrency
type PriceInterval = OneMonth | OtherInterval
type PriceUsage = Licensed | Metered
type PriceMode = LivePrice | TestPrice
type ProviderPrice = { active: bool, productActive: bool, currency: PriceCurrency, amountCents: int, interval: PriceInterval, usage: PriceUsage, perUnit: bool, trial: bool, sameProduct: bool, mode: PriceMode }
type PaidPrices = { plus: ProviderPrice, pro: ProviderPrice }
type CatalogObservation = NoCatalog | ObservedPlus({ plus: ProviderPrice }) | Observed(PaidPrices)
type PriceMismatch = PriceInactive | WrongCurrency | WrongAmount | WrongRecurrence | HasTrial | OtherProduct | WrongMode
type PriceCheck = PriceFits | PriceRefused({ mismatch: PriceMismatch })
pure def modeOf(environment: Environment): PriceMode = if (environment == Production) LivePrice else TestPrice
pure def priceCheck(key: PlanKey, observed: ProviderPrice, environment: Environment): PriceCheck =
  if (not(observed.active and observed.productActive)) PriceRefused({ mismatch: PriceInactive })
  else if (observed.currency != Usd) PriceRefused({ mismatch: WrongCurrency })
  else if (observed.amountCents != amountCentsOf(key)) PriceRefused({ mismatch: WrongAmount })
  else if (observed.interval != OneMonth or observed.usage != Licensed or not(observed.perUnit)) PriceRefused({ mismatch: WrongRecurrence })
  else if (observed.trial) PriceRefused({ mismatch: HasTrial })
  else if (not(observed.sameProduct)) PriceRefused({ mismatch: OtherProduct })
  else if (observed.mode != modeOf(environment)) PriceRefused({ mismatch: WrongMode })
  else PriceFits
pure def planProblem(key: PlanKey, observed: ProviderPrice, environment: Environment): StartProblem =
  val checked = priceCheck(key, observed, environment)
  match checked { | PriceRefused(r) => CatalogMismatch({ plan: key, mismatch: r.mismatch }) | PriceFits => NoProblem }
pure def pricesProblem(environment: Environment, plusPrice: ProviderPrice, proPrice: ProviderPrice): StartProblem = {
  val plus = planProblem(PlusMonthly, plusPrice, environment)
  if (plus != NoProblem) plus else planProblem(ProMonthly, proPrice, environment)
}
pure def catalogProblem(environment: Environment, catalog: CatalogObservation): StartProblem =
  match catalog {
    | Observed(c) => pricesProblem(environment, c.plus, c.pro)
    | ObservedPlus(c) => planProblem(PlusMonthly, c.plus, environment)
    | NoCatalog => CatalogMissing
  }
pure val basePrice: ProviderPrice = { active: true, productActive: true, currency: Usd, amountCents: 3000, interval: OneMonth, usage: Licensed, perUnit: true, trial: false, sameProduct: true, mode: LivePrice }
pure val observedValues: Set[ProviderPrice] =
  Set(basePrice).union(Set({ ...basePrice, amountCents: 10000 })).union(Set({ ...basePrice, mode: TestPrice })).union(Set({ ...basePrice, trial: true })).union(Set({ ...basePrice, currency: OtherCurrency }))
pure val catalogValues: Set[CatalogObservation] = {
  val pro: ProviderPrice = { ...basePrice, amountCents: 10000 }
  Set(NoCatalog).union(Set(Observed({ plus: basePrice, pro: pro }))).union(Set(Observed({ plus: { ...basePrice, mode: TestPrice }, pro: { ...pro, mode: TestPrice } }))).union(Set(Observed({ plus: pro, pro: pro }))).union(observedValues.map(price => ObservedPlus({ plus: price })))
}
```

## Story: Answer only the deployment's own callers

> As the owner of an account, I want the cloud to answer my browser and app
> with my session only from the deployment's own pages, and to say plainly
> when a service is not offered, so that no other site acts with my session
> and my app knows what it cannot use.

### A route of a capability the environment does not enable is refused as 404 capability_unavailable

The shell applies the gate after it parses the credential (a refused
credential answers `401` first) and before it reads the body. Billing gates
only what needs the payment provider: subscriptions with their plan list,
checkout, payer page and portal, invoices, grant redemption and the provider
webhook. The billing snapshot and the entitlement with its keys stay open, so
an account funded only by `credits add` still shows its balance. The maps
capabilities route stays open and answers `{available: false}` with maps off
(`services/maps`). Managed Google gates the Google routes and their callback.
Text inference needs no capability but inference. An inference model’s optional
`defaultMaxTokens` is its provider’s verified maximum generation length for
that exact upstream model, between 1 and 2,000,000. Profiles that omit it
continue to serve requests with an explicit output limit. Sign-in, native client,
public service and return page routes need none.

```quint
type RouteArea =
  ChatCompletionRoutes | ModelListRoutes | BatchSpeechRoutes | SpeechRelayRoutes | MapsCapabilityRoute | MapsOperationRoutes | GoogleRoutes
  | SubscriptionRoutes | InvoiceRoutes | GrantRedemptionRoutes | ProviderWebhookRoutes | BillingSnapshotRoutes | EntitlementRoutes
  | IdentityRoutes | NativeClientRoutes | PublicServiceRoutes | ReturnPageRoutes
type RouteGate = Ungated | Gated({ capability: Capability })
pure def gateOf(area: RouteArea): RouteGate =
  if (Set(ChatCompletionRoutes, ModelListRoutes).contains(area)) Gated({ capability: InferenceCapability })
  else if (Set(BatchSpeechRoutes, SpeechRelayRoutes).contains(area)) Gated({ capability: SpeechCapability })
  else if (area == MapsOperationRoutes) Gated({ capability: MapsCapability })
  else if (area == GoogleRoutes) Gated({ capability: ManagedGoogleCapability })
  else if (Set(SubscriptionRoutes, InvoiceRoutes, GrantRedemptionRoutes, ProviderWebhookRoutes).contains(area)) Gated({ capability: BillingCapability })
  else Ungated
pure def routeOpen(offered: Set[Capability], gate: RouteGate): bool = match gate { | Gated(g) => offered.contains(g.capability) | Ungated => true }
pure val capabilityRefusal: Refusal = refuse(CapabilityUnavailable)
pure val alwaysOpenAreas: Set[RouteArea] = Set(MapsCapabilityRoute, BillingSnapshotRoutes, EntitlementRoutes, IdentityRoutes, NativeClientRoutes, PublicServiceRoutes, ReturnPageRoutes)
pure def lawTextInferenceNeedsOnlyInference(area: RouteArea): bool =
  Set(ChatCompletionRoutes, ModelListRoutes).contains(area) implies routeOpen(Set(InferenceCapability), gateOf(area))
pure def lawBalanceAndSignInNeedNoCapability(area: RouteArea): bool = routeOpen(Set(), gateOf(area)) iff alwaysOpenAreas.contains(area)
```

### The entitlement's services claim names the enabled capabilities in one fixed order

The claim (`billing/entitlements`) is `enabledServices` of the environment's
capabilities, rendered as `inference`, `speech`, `maps`, `managedGoogle`,
`billing`.

```quint
pure val capabilityOrder: List[Capability] = List(InferenceCapability, SpeechCapability, MapsCapability, ManagedGoogleCapability, BillingCapability)
pure def enabledServices(offered: Set[Capability]): List[Capability] = capabilityOrder.select(c => offered.contains(c))
pure def lawServicesListEachEnabledCapabilityOnce(offered: Set[Capability], c: Capability): bool =
  enabledServices(offered).select(x => x == c).length() == (if (offered.contains(c)) 1 else 0)
```

### A credentialed cross-origin request is answered only for an exact first-party origin of the environment

A request whose `Origin` is in the environment's `firstPartyOrigins` gets
that origin reflected with credentials allowed; any other origin gets no CORS
grant, never a wildcard. A request without `Origin` (a native client) needs
none. A preflight admits only the listed methods and request headers, and an
answer exposes only the listed response headers.

```quint
type RequestOrigin = NoOrigin | FromOrigin({ origin: str })
type CorsGrant = NoCorsGrant | CredentialedGrant
pure def corsGrant(row: EnvironmentProfile, requestOrigin: RequestOrigin): CorsGrant =
  match requestOrigin { | FromOrigin(o) => if (row.firstPartyOrigins.includes(o.origin)) CredentialedGrant else NoCorsGrant | NoOrigin => NoCorsGrant }
pure val allowedMethods: List[str] = List("GET", "POST", "PATCH", "DELETE")
pure val allowedRequestHeaders: List[str] = List("Authorization", "Idempotency-Key", "If-Match", "X-Request-Id", "Traceparent", "Tracestate", "Content-Type")
pure val exposedResponseHeaders: List[str] = List("X-Request-Id", "ETag", "Retry-After", "X-Eliza-Speech-Extend", "X-Eliza-TTS-Provider", "X-Eliza-STT-Provider", "X-Eliza-TTS-Speed", "X-Eliza-TTS-Timing")
pure def lawNoCredentialsAcrossEnvironments(p: Profile, environment: Environment): bool = {
  val row = rowOf(p, environment)
  val other = rowOf(p, otherEnvironment(environment))
  profileAccepted(p) implies (corsGrant(row, FromOrigin({ origin: other.web })) == NoCorsGrant and corsGrant(row, FromOrigin({ origin: other.api })) == NoCorsGrant)
}
```

### A sign-in method is offered only when its adapter is configured

`GET /api/v1/auth/methods` answers `{email, sms, google}`. Email needs a mail
adapter, SMS an SMS adapter, Google configured Google clients; an accepted
profile configures at least one. A host advertises a configured method only
when it mounts that method’s start and verification routes. A route of a
method not offered is refused for good. Google returns
`503 provider_unavailable` with reason `google_not_configured` (the registry's
config read says the same). Email and SMS return `404 capability_unavailable`.

```quint
type MethodsAnswer = { email: bool, sms: bool, google: bool }
pure def methodOffered(setup: SignInSetup, m: SignInMethod): bool =
  if (m == EmailSignIn) setup.mail != NoDelivery else if (m == PhoneSignIn) setup.sms != NoDelivery else setup.google == GoogleOn
pure def methodsAnswer(setup: SignInSetup): MethodsAnswer = { email: methodOffered(setup, EmailSignIn), sms: methodOffered(setup, PhoneSignIn), google: methodOffered(setup, GoogleSignIn) }
pure def lawAnAcceptedProfileOffersSomeMethod(p: Profile, environment: Environment): bool = {
  val answer = methodsAnswer(rowOf(p, environment).signIn)
  profileAccepted(p) implies (answer.email or answer.sms or answer.google)
}
pure def mountedMethodsAnswer(setup: SignInSetup, mounted: MethodsAnswer): MethodsAnswer = {
  email: mounted.email and methodOffered(setup, EmailSignIn),
  sms: mounted.sms and methodOffered(setup, PhoneSignIn),
  google: mounted.google and methodOffered(setup, GoogleSignIn)
}
pure val deliverySetupValues: Set[SignInSetup] = Set(
  { mail: HttpsDelivery, sms: NoDelivery, google: GoogleOff },
  { mail: HttpsDelivery, sms: HttpsDelivery, google: GoogleOn }
)
pure val mountedValues: Set[MethodsAnswer] = Set(
  { email: false, sms: false, google: false },
  { email: true, sms: true, google: true }
)
pure def lawUnservedMethodsAreNotOffered(deliverySetup: SignInSetup, mounted: MethodsAnswer): bool = {
  val offered = mountedMethodsAnswer(deliverySetup, mounted)
  (offered.email implies mounted.email) and (offered.sms implies mounted.sms) and (offered.google implies mounted.google)
}
pure def methodRefusal(m: SignInMethod): Refusal = if (m == GoogleSignIn) refuseFor(ProviderUnavailable, GoogleNotConfigured) else capabilityRefusal
pure def lawAMissingMethodIsRefusedForGood(m: SignInMethod): bool = wellFormed(methodRefusal(m)) and not(retryableOf(methodRefusal(m)))
```

### The public service document carries the environment's name and complete terms and privacy

`GET /api/public/service` answers `{success: true, version: 1, service:
{name, terms, privacy}}` with `Cache-Control: no-store`; the products' parser
refuses an empty name, title, section list or paragraph, so an accepted
profile never serves one. `GET /api/health` answers without reading any
store.

```quint
type ServiceDocument = { name: str, terms: LegalDocument, privacy: LegalDocument }
pure val serviceDocumentVersion = 1
pure def serviceDocument(row: EnvironmentProfile): ServiceDocument = { name: row.name, terms: row.terms, privacy: row.privacy }
pure def lawAnAcceptedProfileServesCompleteDocuments(p: Profile, environment: Environment): bool = {
  val d = serviceDocument(rowOf(p, environment))
  profileAccepted(p) implies (d.name != "" and documentComplete(d.terms) and documentComplete(d.privacy))
}
```

## Story: Serve the deployment from a Worker

> As the operator of a product deployment on Cloudflare Workers, I want the
> Worker to answer the same routes, from the same handlers and the same
> reviewed profile, as `elizaos-cloud serve` does, so that my app signs in,
> renews its key, subscribes, speaks, maps and reads Google the same way on
> either host.

The Worker (`@elizaos/cloud-worker`) reads its profile from the
`CLOUD_PROFILE` binding (the profile's JSON) and its environment from
`CLOUD_ENVIRONMENT`, its secrets and mail binding from the Worker's other bindings, and its
database from Hyperdrive. Each request gets one connection to the database,
held until the answer's body ends. It never migrates and never seeds:
`elizaos-cloud migrate` and `elizaos-cloud client apply` (`operator`) prepare
the database first. Its bindings `PUBLIC_API_ORIGIN`, `WEB_ORIGIN` and
`CLOUD_IDENTITY_DIGEST`, which its Worker-only routes read, repeat the profile's API origin, web origin and database
digest, and its `NATIVE_CLIENT_REGISTRY` binding, when set, repeats the
database's registrations. Its return pages are the package's built pages
(`dist/pages`, with their compiled stylesheet) bound as the Worker's static
assets `ASSETS`, with the Worker run first so no template is served bare;
`serve` reads the same files from the package.

### A Worker serves only after the server's own start checks pass and its bindings agree with its profile

The first request of an isolate runs the start checks of `serve` for a
Postgres store without a seed: the profile, the database identity, loopback
delivery, the secrets and mail binding and, with billing on, the payment catalog. Until they
pass, and while a binding disagrees with the profile, every request is
answered `503 service_unavailable`, retryable.

```quint
type WorkerStart = WorkerServes | WorkerBindingsDisagree | WorkerRefused({ problem: StartProblem })
pure def workerStart(p: Profile, environment: Environment, read: IdentityRead, bindingsAgree: bool, catalog: CatalogObservation): WorkerStart = {
  val problem = startProblem(p, environment, PostgresStore, read, false, catalog)
  if (not(bindingsAgree)) WorkerBindingsDisagree
  else if (problem == NoProblem) WorkerServes
  else WorkerRefused({ problem: problem })
}
pure val bindingsAgreeValues = Set(true, false)
pure def lawAWorkerServesOnlyWhereTheServerWouldStart(p: Profile, environment: Environment, read: IdentityRead, bindingsAgree: bool, catalog: CatalogObservation): bool =
  workerStart(p, environment, read, bindingsAgree, catalog) == WorkerServes implies (bindingsAgree and canServe(p, environment, PostgresStore, read, false, catalog))
pure def lawAWorkerNeverOpensTheOtherEnvironmentsDatabase(p: Profile, environment: Environment, read: IdentityRead, bindingsAgree: bool, catalog: CatalogObservation): bool =
  workerStart(p, environment, read, bindingsAgree, catalog) == WorkerServes implies read != ReadDigest({ digest: rowOf(p, otherEnvironment(environment)).databaseDigest })
```

### A Worker answers a path from the server's route table first, and its Worker-only routes only for a path the table does not serve

The table is every route `serve` mounts. The relay socket
(`services/speechRelay`) runs the same route on the server half of a Worker
socket pair, answered `101` once the route upgrades and kept running after
that answer with its own database connection; the provider's realtime sockets
are dialed by fetch upgrade, the Worker's way to send handshake headers. The
Worker-only routes are the device enrollment
under `/api/auth/` with the native Google challenge, password backup,
bounded decisions, the device's calendar reminders and selected Google
attachments, a product's own `/api/product/` routes and `/health`. A path in
neither is answered by the table's return page fallback, or `404 not_found`.
CORS and refusals are the table's for its routes.

```quint
type WorkerAnswer = FromServerTable | FromWorkerOnly | FromServerFallback
pure def workerAnswer(inTable: bool, workerOnly: bool): WorkerAnswer =
  if (inTable) FromServerTable else if (workerOnly) FromWorkerOnly else FromServerFallback
pure val inTableValues = Set(true, false)
pure val workerOnlyValues = Set(true, false)
pure def lawATableRouteIsNeverShadowed(inTable: bool, workerOnly: bool): bool =
  inTable implies workerAnswer(inTable, workerOnly) == FromServerTable
pure def lawAWorkerOnlyRouteNeverReplacesTheTable(inTable: bool, workerOnly: bool): bool =
  workerAnswer(inTable, workerOnly) == FromWorkerOnly implies (workerOnly and not(inTable))
```

### A scheduled tick runs each sweep whose period ends within the tick

The Worker's cron fires once a minute, on the minute. Each tick runs, one at
a time, every sweep of the served table whose period divides a time within
the minute before the tick, so a sweep of a whole number of minutes runs once
per period, and one of a minute or less at every tick.

```quint
pure val sweepTick: Millis = millisPerMinute
pure def sweepDue(scheduledAt: Millis, everyMs: Millis): bool = {
  val elapsed = if (everyMs > 0) scheduledAt % everyMs else 0
  everyMs > 0 and (if (elapsed < 0) elapsed + everyMs else elapsed) < sweepTick
}
pure val scheduledAtValues = Set(-120001, -120000, -119999, -60000, -1, 0, 60000, 300000, 3540000, 3600000)
pure val everyMsValues = Set(30000, 60000, 300000, 3600000)
pure def lawAWholeMinuteSweepRunsAtItsPeriodOnly(scheduledAt: Millis, everyMs: Millis): bool =
  (everyMs >= sweepTick and everyMs % sweepTick == 0 and scheduledAt % sweepTick == 0) implies (sweepDue(scheduledAt, everyMs) iff scheduledAt % everyMs == 0)
pure def lawAShortSweepRunsAtEveryTick(scheduledAt: Millis, everyMs: Millis): bool =
  (everyMs > 0 and everyMs <= sweepTick) implies sweepDue(scheduledAt, everyMs)
```

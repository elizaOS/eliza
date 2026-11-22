# Deployment profile

One reviewed profile describes a deployment's production and staging
environments: the callers, capabilities, sign-in methods and public documents
of each. An instance serves the one environment it was started with, and
starts only when the profile, the database and the payment catalog agree.

This library has no state. The profile's Effect Schema
(`src/profile/profile.schema.ts`) owns every string format and names the
secrets read from the environment; no rule sees a secret. An origin (`api`,
`web` and each `firstPartyOrigins` entry) is an HTTPS URL equal to its own
serialized origin: lower-case host, no default port, no path, query,
fragment or credentials, so string equality below is origin equality. The
display name has 1 to 80 characters and no control or format character. The
name and every title, revision, section title and paragraph are trimmed and
must not be blank; the Quint receives the trimmed values.

## Story: Configure a deployment from one reviewed profile

> As the operator of a deployment, I want to describe production and staging
> once and start each instance from that description, so that no instance
> trusts an authority, a database or a price the profile does not name.

### A profile is accepted only when its two environments share no origin or database, production uses no loopback adapter, and each environment offers a sign-in method, a consistent maps provider and complete documents

Each environment names its display name, API and web origins, entitlement
audience, mail sender, expected database identity digest, exact first-party
origins, enabled capabilities, maps provider, sign-in adapters and legal
documents. There is no tenant, no third environment and no credential
namespace. No API or web origin of one environment is an origin of the
other, and no origin is first party in both; one environment may serve API
and web on one origin, as local development does. The `maps` capability is
on exactly when the maps provider is not `none`. Each terms and privacy
document has a title, a revision and at least one section, each section a
title and at least one paragraph, none of them blank. The schema also
carries the parts `services/models`, `identity/codeChallenges` and
`nativeClients/registry` read.

```quint
import types.* from "./shared/types"
import plans.* from "./billing/plans"
type Environment = Production | Staging
type Capability = InferenceCapability | SpeechCapability | MapsCapability | ManagedGoogleCapability | BillingCapability
type MapsProvider = GoogleMaps | OsmMaps | NoMaps
type DeliveryAdapter = HttpsDelivery | LoopbackDelivery | NoDelivery
type GoogleSetup = GoogleOff | GoogleOn
type SignInSetup = { mail: DeliveryAdapter, sms: DeliveryAdapter, google: GoogleSetup }
type DocumentSection = { title: str, paragraphs: List[str] }
type LegalDocument = { title: str, revision: str, sections: List[DocumentSection] }
type EnvironmentProfile = { name: str, api: str, web: str, audience: str, mailSender: str, databaseDigest: str, firstPartyOrigins: List[str], capabilities: Set[Capability], mapsProvider: MapsProvider, signIn: SignInSetup, terms: LegalDocument, privacy: LegalDocument }
type Profile = { production: EnvironmentProfile, staging: EnvironmentProfile }
pure def rowOf(p: Profile, environment: Environment): EnvironmentProfile = if (environment == Production) p.production else p.staging
pure def otherEnvironment(environment: Environment): Environment = if (environment == Production) Staging else Production
pure def usesLoopback(row: EnvironmentProfile): bool = row.signIn.mail == LoopbackDelivery or row.signIn.sms == LoopbackDelivery
pure def someMethodOffered(setup: SignInSetup): bool = methodOffered(setup, EmailSignIn) or methodOffered(setup, PhoneSignIn) or methodOffered(setup, GoogleSignIn)
pure def documentComplete(d: LegalDocument): bool =
  d.title != "" and d.revision != "" and d.sections.length() > 0
  and d.sections.every(x => x.title != "" and x.paragraphs.length() > 0 and x.paragraphs.every(t => t != ""))
pure def environmentAccepted(row: EnvironmentProfile, other: EnvironmentProfile): bool =
  row.name != "" and not(row.firstPartyOrigins.includes(other.api)) and not(row.firstPartyOrigins.includes(other.web))
  and row.firstPartyOrigins.every(o => not(other.firstPartyOrigins.includes(o)))
  and (row.capabilities.contains(MapsCapability) iff row.mapsProvider != NoMaps)
  and someMethodOffered(row.signIn) and documentComplete(row.terms) and documentComplete(row.privacy)
pure def profileAccepted(p: Profile): bool = {
  val a = p.production
  val b = p.staging
  a.api != b.api and a.api != b.web and a.web != b.api and a.web != b.web
  and a.databaseDigest != b.databaseDigest and not(usesLoopback(a))
  and environmentAccepted(a, b) and environmentAccepted(b, a)
}
pure val pValues: Set[Profile] = {
  val doc: LegalDocument = { title: "Terms", revision: "1", sections: List({ title: "Use", paragraphs: List("Plain text.") }) }
  val prod: EnvironmentProfile = { name: "Cloud", api: "https://api.one", web: "https://www.one", audience: "aud", mailSender: "m@one", databaseDigest: "d1", firstPartyOrigins: List("https://www.one"), capabilities: Set(InferenceCapability, SpeechCapability, MapsCapability, ManagedGoogleCapability, BillingCapability), mapsProvider: GoogleMaps, signIn: { mail: HttpsDelivery, sms: HttpsDelivery, google: GoogleOn }, terms: doc, privacy: doc }
  val stag: EnvironmentProfile = { ...prod, api: "https://api.two", web: "https://www.two", databaseDigest: "d2", firstPartyOrigins: List("https://www.two"), capabilities: Set(InferenceCapability), mapsProvider: NoMaps, signIn: { mail: LoopbackDelivery, sms: LoopbackDelivery, google: GoogleOff } }
  val ok: Profile = { production: prod, staging: stag }
  Set(ok)
    .union(Set({ ...ok, staging: { ...stag, web: "https://api.two", firstPartyOrigins: List("https://api.two") } }))
    .union(Set({ ...ok, staging: { ...stag, databaseDigest: "d1" } }))
    .union(Set({ ...ok, staging: { ...stag, api: "https://api.one" } }))
    .union(Set({ ...ok, staging: { ...stag, firstPartyOrigins: List("https://www.one") } }))
    .union(Set({ production: { ...prod, firstPartyOrigins: List("https://www.one", "https://shared.dev") }, staging: { ...stag, firstPartyOrigins: List("https://shared.dev") } }))
    .union(Set({ ...ok, production: { ...prod, signIn: { mail: HttpsDelivery, sms: LoopbackDelivery, google: GoogleOn } } }))
    .union(Set({ ...ok, staging: { ...stag, signIn: { mail: NoDelivery, sms: NoDelivery, google: GoogleOff } } }))
    .union(Set({ ...ok, staging: { ...stag, mapsProvider: OsmMaps } }))
    .union(Set({ ...ok, production: { ...prod, terms: { ...doc, sections: List() } } }))
    .union(Set({ ...ok, production: { ...prod, name: "" } }))
}
```

### An instance starts only for an accepted profile, on its environment's own readable database, seeded only in staging, with loopback delivery and its test inbox only on PGlite

`elizaos-cloud serve --environment <e>` refuses to start, naming the first
problem in this order. The database identity digest is SHA-256 over
`eliza-postgres-authority-v1`, the environment, the cluster
`system_identifier`, the role name and the database name, each followed by
a NUL byte, read by the same query on `pg` and PGlite; an identity the shell
cannot read and another database's identity are distinct problems. A
harness that creates a new PGlite store reads its digest and writes it into
the profile it then starts with. `--seed` (registrations and prices) is
refused outside staging. With billing enabled, the payment catalog must also
fit (next rule). With the loopback adapter, `GET /api/test/inbox/:destination`
answers the latest message per destination only on the loopback interface;
otherwise it answers `404 not_found`.

```quint
type StoreKind = PostgresStore | PgliteStore
type StoreIdentity = MatchingDatabase | OtherDatabase | UnreadableDatabase
type IdentityRead = UnreadableIdentity | ReadDigest({ digest: str })
type StartProblem = StartsCleanly | ProfileRefused | DatabaseUnreadable | DatabaseMismatch | SeedOutsideStaging | LoopbackOutsidePglite | CatalogMissing | CatalogMismatch({ plan: PlanKey, mismatch: PriceMismatch })
pure def identityOf(p: Profile, environment: Environment, read: IdentityRead): StoreIdentity = match read {
  | ReadDigest(r) => if (r.digest == rowOf(p, environment).databaseDigest) MatchingDatabase else OtherDatabase
  | UnreadableIdentity => UnreadableDatabase
}
pure def loopbackAllowed(store: StoreKind): bool = store == PgliteStore
pure def inboxOpen(row: EnvironmentProfile, store: StoreKind, fromLoopbackInterface: bool): bool = usesLoopback(row) and loopbackAllowed(store) and fromLoopbackInterface
pure def startProblem(p: Profile, environment: Environment, store: StoreKind, read: IdentityRead, seeded: bool, catalog: CatalogObservation): StartProblem = {
  val row = rowOf(p, environment)
  val identity = identityOf(p, environment, read)
  if (not(profileAccepted(p))) ProfileRefused
  else if (identity == UnreadableDatabase) DatabaseUnreadable
  else if (identity == OtherDatabase) DatabaseMismatch
  else if (seeded and environment != Staging) SeedOutsideStaging
  else if (usesLoopback(row) and not(loopbackAllowed(store))) LoopbackOutsidePglite
  else if (row.capabilities.contains(BillingCapability)) catalogProblem(environment, catalog)
  else StartsCleanly
}
pure def canServe(p: Profile, environment: Environment, store: StoreKind, read: IdentityRead, seeded: bool, catalog: CatalogObservation): bool = startProblem(p, environment, store, read, seeded, catalog) == StartsCleanly
pure val readValues: Set[IdentityRead] = Set(UnreadableIdentity).union(Set(ReadDigest({ digest: "d1" }))).union(Set(ReadDigest({ digest: "d2" }))).union(Set(ReadDigest({ digest: "d3" })))
pure def lawAnInstanceNeverOpensTheOtherEnvironmentsDatabase(p: Profile, environment: Environment, store: StoreKind, read: IdentityRead, seeded: bool, catalog: CatalogObservation): bool =
  canServe(p, environment, store, read, seeded, catalog) implies read != ReadDigest({ digest: rowOf(p, otherEnvironment(environment)).databaseDigest })
```

### Each paid plan's provider price must be active, in US dollars, the catalog amount, monthly per seat, without trial, on its product and in the environment's mode

The check runs at `serve` start and in `elizaos-cloud prices check`. The
catalog is missing when a paid plan's price or product id is not configured
or the provider cannot be read. Otherwise the shell reduces what it reads:
active means the price and its product are both active; any currency option
other than US dollars is `OtherCurrency`; `MonthlyPerSeat` means type
`recurring`, one month, licensed, billing scheme `per_unit` and no quantity
transform; the mode is live or test when price and product agree and
`MixedMode` when they do not. Production sells only live prices and staging
only test prices. Any mismatch refuses the start; nothing is published from
a partial catalog.

```quint
type PriceCurrency = UsdCurrency | OtherCurrency
type PriceRecurrence = MonthlyPerSeat | OtherRecurrence
type PriceMode = LivePrice | TestPrice | MixedMode
type ProviderPrice = { active: bool, currency: PriceCurrency, amountCents: int, recurrence: PriceRecurrence, trial: bool, sameProduct: bool, mode: PriceMode }
type PaidPrices = { plus: ProviderPrice, pro: ProviderPrice }
type CatalogObservation = NoCatalog | CatalogObserved(PaidPrices)
type PriceMismatch = PriceInactive | WrongCurrency | WrongAmount | WrongRecurrence | HasTrial | OtherProduct | WrongMode
pure def modeOf(environment: Environment): PriceMode = if (environment == Production) LivePrice else TestPrice
pure def priceCheck(key: PlanKey, observed: ProviderPrice, environment: Environment): StartProblem =
  if (not(observed.active)) CatalogMismatch({ plan: key, mismatch: PriceInactive })
  else if (observed.currency != UsdCurrency) CatalogMismatch({ plan: key, mismatch: WrongCurrency })
  else if (observed.amountCents != amountCentsOf(key)) CatalogMismatch({ plan: key, mismatch: WrongAmount })
  else if (observed.recurrence != MonthlyPerSeat) CatalogMismatch({ plan: key, mismatch: WrongRecurrence })
  else if (observed.trial) CatalogMismatch({ plan: key, mismatch: HasTrial })
  else if (not(observed.sameProduct)) CatalogMismatch({ plan: key, mismatch: OtherProduct })
  else if (observed.mode != modeOf(environment)) CatalogMismatch({ plan: key, mismatch: WrongMode })
  else StartsCleanly
pure def pricesProblem(environment: Environment, plusPrice: ProviderPrice, proPrice: ProviderPrice): StartProblem = {
  val plus = priceCheck(PlusMonthly, plusPrice, environment)
  if (plus != StartsCleanly) plus else priceCheck(ProMonthly, proPrice, environment)
}
pure def catalogProblem(environment: Environment, catalog: CatalogObservation): StartProblem =
  match catalog { | CatalogObserved(c) => pricesProblem(environment, c.plus, c.pro) | NoCatalog => CatalogMissing }
pure val catalogValues: Set[CatalogObservation] = {
  val plus: ProviderPrice = { active: true, currency: UsdCurrency, amountCents: 3000, recurrence: MonthlyPerSeat, trial: false, sameProduct: true, mode: LivePrice }
  val pro: ProviderPrice = { ...plus, amountCents: 10000 }
  Set(NoCatalog)
    .union(Set(CatalogObserved({ plus: plus, pro: pro })))
    .union(Set(CatalogObserved({ plus: { ...plus, mode: TestPrice }, pro: { ...pro, mode: TestPrice } })))
    .union(Set(CatalogObserved({ plus: { ...plus, mode: MixedMode }, pro: pro })))
    .union(Set(CatalogObserved({ plus: pro, pro: pro })))
    .union(Set(CatalogObserved({ plus: { ...plus, active: false }, pro: pro })))
    .union(Set(CatalogObserved({ plus: { ...plus, currency: OtherCurrency }, pro: pro })))
    .union(Set(CatalogObserved({ plus: plus, pro: { ...pro, recurrence: OtherRecurrence } })))
    .union(Set(CatalogObserved({ plus: { ...plus, trial: true }, pro: pro })))
    .union(Set(CatalogObserved({ plus: plus, pro: { ...pro, sameProduct: false } })))
}
```

## Story: Answer only the deployment's own callers

> As the owner of an account, I want the cloud to answer my browser and app
> with my session only from the deployment's own pages, and to say plainly
> when a service is not offered, so that no other site acts with my session
> and my app knows what it cannot use.

### A route of a capability the environment does not enable is refused for good as 404 capability_unavailable

The shell applies the gate after it parses the credential (a refused
credential answers `401` first) and before it reads the body. Billing gates
only what needs the payment provider: subscriptions with their plan list,
checkout, the payer page `/api/v1/subscriptions/checkout/payer` and the
portal, invoices, grant redemption and the provider webhook. The billing
snapshot and the entitlement with its keys stay open, so an account funded
only by `credits add` still shows its balance. The maps capabilities route
stays open and answers `{available: false}` with maps off (`services/maps`).
Managed Google gates the Google routes and their callback. Text inference
needs only inference. Sign-in, native client, public service and return page
routes (ReturnToApp pages only) need none.

```quint
type RouteArea =
  ChatCompletionRoutes | ModelListRoutes | BatchSpeechRoutes | SpeechRelayRoutes | MapsCapabilityRoute | MapsOperationRoutes | GoogleRoutes
  | SubscriptionRoutes | InvoiceRoutes | GrantRedemptionRoutes | ProviderWebhookRoutes | BillingSnapshotRoutes | EntitlementRoutes
  | IdentityRoutes | NativeClientRoutes | PublicServiceRoutes | ReturnPageRoutes
type RouteGate = NoCapabilityGate | CapabilityGated({ capability: Capability })
pure def gateOf(area: RouteArea): RouteGate =
  if (Set(ChatCompletionRoutes, ModelListRoutes).contains(area)) CapabilityGated({ capability: InferenceCapability })
  else if (Set(BatchSpeechRoutes, SpeechRelayRoutes).contains(area)) CapabilityGated({ capability: SpeechCapability })
  else if (area == MapsOperationRoutes) CapabilityGated({ capability: MapsCapability })
  else if (area == GoogleRoutes) CapabilityGated({ capability: ManagedGoogleCapability })
  else if (Set(SubscriptionRoutes, InvoiceRoutes, GrantRedemptionRoutes, ProviderWebhookRoutes).contains(area)) CapabilityGated({ capability: BillingCapability })
  else NoCapabilityGate
pure def routeOpen(offered: Set[Capability], gate: RouteGate): bool = match gate { | CapabilityGated(g) => offered.contains(g.capability) | NoCapabilityGate => true }
pure val capabilityRefusal: Refusal = refuse(CapabilityUnavailable)
pure val alwaysOpenAreas: Set[RouteArea] = Set(MapsCapabilityRoute, BillingSnapshotRoutes, EntitlementRoutes, IdentityRoutes, NativeClientRoutes, PublicServiceRoutes, ReturnPageRoutes)
pure def lawBalanceAndSignInNeedNoCapability(area: RouteArea): bool = routeOpen(Set(), gateOf(area)) iff alwaysOpenAreas.contains(area)
pure def lawAClosedRouteIsRefusedForGood(area: RouteArea): bool =
  not(routeOpen(Set(), gateOf(area))) implies (statusOf(capabilityRefusal.code) == 404 and wellFormed(capabilityRefusal) and not(retryableOf(capabilityRefusal)))
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
answer exposes only the listed response headers. Under an accepted profile
no origin gets credentials from both environments.

```quint
type RequestOrigin = NoRequestOrigin | FromRequestOrigin({ origin: str })
type CorsGrant = NoCorsGrant | CredentialedGrant
pure def corsGrant(row: EnvironmentProfile, requestOrigin: RequestOrigin): CorsGrant =
  match requestOrigin { | FromRequestOrigin(o) => if (row.firstPartyOrigins.includes(o.origin)) CredentialedGrant else NoCorsGrant | NoRequestOrigin => NoCorsGrant }
pure val allowedMethods: List[str] = List("GET", "POST", "PATCH", "DELETE")
pure val allowedRequestHeaders: List[str] = List("Authorization", "Idempotency-Key", "If-Match", "X-Request-Id", "Traceparent", "Tracestate", "Content-Type")
pure val exposedResponseHeaders: List[str] = List("X-Request-Id", "ETag", "Retry-After", "X-Eliza-Speech-Extend", "X-Eliza-TTS-Provider", "X-Eliza-STT-Provider", "X-Eliza-TTS-Speed", "X-Eliza-TTS-Timing")
pure val originValues: Set[str] = Set("https://www.one", "https://www.two", "https://api.one", "https://shared.dev")
pure def lawNoCredentialsAcrossEnvironments(p: Profile, origin: str): bool =
  profileAccepted(p) implies not(corsGrant(p.production, FromRequestOrigin({ origin: origin })) == CredentialedGrant and corsGrant(p.staging, FromRequestOrigin({ origin: origin })) == CredentialedGrant)
```

### A sign-in method is offered only when its adapter is configured and its routes are mounted

`GET /api/v1/auth/methods` answers `{email, sms, google}`. Email needs a mail
adapter, SMS an SMS adapter, Google configured Google clients; an accepted
profile configures at least one. A host advertises a configured method only
when it mounts that method's start and verification routes. A route of a
method not offered is refused for good. Google returns
`503 provider_unavailable` with reason `google_not_configured` (the registry's
config read says the same). Email and SMS return `404 capability_unavailable`.

```quint
type MethodsAnswer = { email: bool, sms: bool, google: bool }
pure def methodOffered(setup: SignInSetup, m: SignInMethod): bool =
  if (m == EmailSignIn) setup.mail != NoDelivery else if (m == PhoneSignIn) setup.sms != NoDelivery else setup.google == GoogleOn
pure def methodsAnswer(setup: SignInSetup): MethodsAnswer = { email: methodOffered(setup, EmailSignIn), sms: methodOffered(setup, PhoneSignIn), google: methodOffered(setup, GoogleSignIn) }
pure def mountedMethodsAnswer(setup: SignInSetup, mounted: MethodsAnswer): MethodsAnswer = {
  email: mounted.email and methodOffered(setup, EmailSignIn),
  sms: mounted.sms and methodOffered(setup, PhoneSignIn),
  google: mounted.google and methodOffered(setup, GoogleSignIn)
}
pure def methodRefusal(m: SignInMethod): Refusal = if (m == GoogleSignIn) refuseFor(ProviderUnavailable, GoogleNotConfigured) else capabilityRefusal
pure def lawAMissingMethodIsRefusedForGood(m: SignInMethod): bool = wellFormed(methodRefusal(m)) and not(retryableOf(methodRefusal(m)))
```

### The public service document carries the served environment's name, terms and privacy, version 1

`GET /api/public/service` answers `{success: true, version: 1, service:
{name, terms, privacy}}` with `Cache-Control: no-store`; an accepted profile
holds nothing blank the products' parser refuses. `GET /api/health` answers
without reading any store.

```quint
type ServiceDocument = { name: str, terms: LegalDocument, privacy: LegalDocument }
pure val serviceDocumentVersion = 1
pure def serviceDocument(row: EnvironmentProfile): ServiceDocument = { name: row.name, terms: row.terms, privacy: row.privacy }
```

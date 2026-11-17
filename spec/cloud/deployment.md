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

This library has no state. The profile is parsed by its Effect Schema
(`src/profile/profile.schema.ts`), which owns every string format: origins are
HTTPS with no path, credentials or port; a display name is trimmed, at most 80
characters and free of control characters; texts are trimmed before they reach
these rules. Secrets (provider keys, signing keys) are named by the profile
and read from the environment; no rule sees one.

## Story: Configure a deployment from one reviewed profile

> As the operator of a deployment, I want to describe production and staging
> once and start each instance from that description, so that no instance
> trusts an authority, a database or a price the profile does not name.

### A profile holds exactly production and staging, which share no API origin, web origin or database

Each environment names its display name, API and web origins, entitlement
audience, mail sender, expected database identity digest, exact first-party
origins, enabled capabilities, sign-in adapters and legal documents. There is
no tenant, no third origin and no credential namespace. Neither environment
lists the other's web origin as first party, and production never uses the
`loopback` mail or SMS adapter.

```quint
import types.* from "./shared/types"
import plans.* from "./billing/plans"
type Environment = Production | Staging
type Capability = Inference | Speech | Maps | ManagedGoogle | Billing
type DeliveryAdapter = HttpsDelivery | LoopbackDelivery | NoDelivery
type GoogleSetup = GoogleOff | GoogleOn
type SignInSetup = { mail: DeliveryAdapter, sms: DeliveryAdapter, google: GoogleSetup }
type DocumentSection = { title: str, paragraphs: List[str] }
type LegalDocument = { title: str, revision: str, sections: List[DocumentSection] }
type EnvironmentProfile = { name: str, api: str, web: str, audience: str, mailSender: str, databaseDigest: str, firstPartyOrigins: List[str], capabilities: Set[Capability], signIn: SignInSetup, terms: LegalDocument, privacy: LegalDocument }
type Profile = { production: EnvironmentProfile, staging: EnvironmentProfile }
pure def rowOf(p: Profile, environment: Environment): EnvironmentProfile = if (environment == Production) p.production else p.staging
pure def otherEnvironment(environment: Environment): Environment = if (environment == Production) Staging else Production
pure def usesLoopback(row: EnvironmentProfile): bool = row.signIn.mail == LoopbackDelivery or row.signIn.sms == LoopbackDelivery
pure def documentComplete(d: LegalDocument): bool =
  d.title != "" and d.revision != "" and d.sections.length() > 0
  and d.sections.every(x => x.title != "" and x.paragraphs.length() > 0 and x.paragraphs.every(t => t != ""))
pure def profileAccepted(p: Profile): bool =
  p.production.api != p.staging.api and p.production.web != p.staging.web
  and p.production.databaseDigest != p.staging.databaseDigest
  and not(p.production.firstPartyOrigins.includes(p.staging.web)) and not(p.staging.firstPartyOrigins.includes(p.production.web))
  and not(usesLoopback(p.production))
  and documentComplete(p.production.terms) and documentComplete(p.production.privacy)
  and documentComplete(p.staging.terms) and documentComplete(p.staging.privacy)
pure val pValues: Set[Profile] = {
  val doc: LegalDocument = { title: "Terms", revision: "1", sections: List({ title: "Use", paragraphs: List("Plain text.") }) }
  val prod: EnvironmentProfile = { name: "Cloud", api: "https://api.one", web: "https://www.one", audience: "aud", mailSender: "m@one", databaseDigest: "d1", firstPartyOrigins: List("https://www.one"), capabilities: Set(Inference, Speech, Maps, ManagedGoogle, Billing), signIn: { mail: HttpsDelivery, sms: HttpsDelivery, google: GoogleOn }, terms: doc, privacy: doc }
  val stag: EnvironmentProfile = { ...prod, api: "https://api.two", web: "https://www.two", databaseDigest: "d2", firstPartyOrigins: List("https://www.two"), capabilities: Set(Inference), signIn: { mail: LoopbackDelivery, sms: LoopbackDelivery, google: GoogleOff } }
  Set({ production: prod, staging: stag })
    .union(Set({ production: prod, staging: { ...stag, databaseDigest: "d1" } }))
    .union(Set({ production: prod, staging: { ...stag, firstPartyOrigins: List("https://www.one") } }))
    .union(Set({ production: { ...prod, signIn: { mail: HttpsDelivery, sms: LoopbackDelivery, google: GoogleOn } }, staging: stag }))
    .union(Set({ production: { ...prod, terms: { ...doc, sections: List() } }, staging: stag }))
}
pure val environmentValues = Set(Production, Staging)
```

### An instance starts only for an accepted profile, on its environment's own database, with loopback delivery only in staging on PGlite

`elizaos-cloud serve --environment <e>` refuses to start, naming the first
problem, unless the profile is accepted, the connected database's identity
digest equals the environment's expected digest, and any `loopback` adapter
runs in staging on a PGlite store. With billing enabled, the payment catalog
must also fit (next rule). The started instance reads only its own row.

```quint
type StoreKind = PostgresStore | PgliteStore
type PriceCurrency = Usd | OtherCurrency
type PriceInterval = OneMonth | OtherInterval
type PriceUsage = Licensed | Metered
type ProviderPrice = { active: bool, productActive: bool, currency: PriceCurrency, amountCents: int, interval: PriceInterval, usage: PriceUsage, perUnit: bool, trial: bool, sameProduct: bool, livemode: bool }
type PaidPrices = { plus: ProviderPrice, pro: ProviderPrice }
type CatalogObservation = NoCatalog | Observed(PaidPrices)
type PriceMismatch = NoMismatch | PriceInactive | WrongCurrency | WrongAmount | WrongRecurrence | HasTrial | OtherProduct | WrongMode
type StartProblem = NoProblem | ProfileRefused | DatabaseMismatch | LoopbackOutsideStaging | CatalogMissing | CatalogMismatch({ plan: PlanKey, mismatch: PriceMismatch })
pure def loopbackAllowed(environment: Environment, store: StoreKind): bool = environment == Staging and store == PgliteStore
pure def startProblem(p: Profile, environment: Environment, store: StoreKind, connectedDigest: str, catalog: CatalogObservation): StartProblem = {
  val row = rowOf(p, environment)
  if (not(profileAccepted(p))) ProfileRefused
  else if (connectedDigest != row.databaseDigest) DatabaseMismatch
  else if (usesLoopback(row) and not(loopbackAllowed(environment, store))) LoopbackOutsideStaging
  else if (row.capabilities.contains(Billing)) catalogProblem(environment, catalog)
  else NoProblem
}
pure def canServe(p: Profile, environment: Environment, store: StoreKind, connectedDigest: str, catalog: CatalogObservation): bool = startProblem(p, environment, store, connectedDigest, catalog) == NoProblem
pure val connectedDigestValues = Set("d1", "d2", "d3")
pure def lawAnInstanceNeverOpensTheOtherEnvironmentsDatabase(p: Profile, environment: Environment, store: StoreKind, connectedDigest: str, catalog: CatalogObservation): bool =
  canServe(p, environment, store, connectedDigest, catalog) implies connectedDigest != rowOf(p, otherEnvironment(environment)).databaseDigest
pure def lawLoopbackOnlyInStagingOnPglite(p: Profile, environment: Environment, store: StoreKind, connectedDigest: str, catalog: CatalogObservation): bool =
  (canServe(p, environment, store, connectedDigest, catalog) and usesLoopback(rowOf(p, environment))) implies loopbackAllowed(environment, store)
```

### Each paid plan's provider price must be active, in US dollars, the catalog amount, monthly, licensed, without trial, on its product and in the environment's mode

The check runs at `serve` start and in `elizaos-cloud prices check`. The
shell reads each paid plan's configured price and product from the provider
and reports any currency option other than US dollars as `OtherCurrency`;
recurrence fits only for one month, per unit and no quantity transform.
Production sells only live prices and staging only test prices. Any mismatch
refuses the start; nothing is published from a partial catalog.

```quint
pure def priceMismatch(key: PlanKey, observed: ProviderPrice, environment: Environment): PriceMismatch =
  if (not(observed.active and observed.productActive)) PriceInactive
  else if (observed.currency != Usd) WrongCurrency
  else if (observed.amountCents != amountCentsOf(key)) WrongAmount
  else if (observed.interval != OneMonth or observed.usage != Licensed or not(observed.perUnit)) WrongRecurrence
  else if (observed.trial) HasTrial
  else if (not(observed.sameProduct)) OtherProduct
  else if (observed.livemode != (environment == Production)) WrongMode
  else NoMismatch
pure def pricesProblem(environment: Environment, plusPrice: ProviderPrice, proPrice: ProviderPrice): StartProblem =
  if (priceMismatch(PlusMonthly, plusPrice, environment) != NoMismatch) CatalogMismatch({ plan: PlusMonthly, mismatch: priceMismatch(PlusMonthly, plusPrice, environment) })
  else if (priceMismatch(ProMonthly, proPrice, environment) != NoMismatch) CatalogMismatch({ plan: ProMonthly, mismatch: priceMismatch(ProMonthly, proPrice, environment) })
  else NoProblem
pure def catalogProblem(environment: Environment, catalog: CatalogObservation): StartProblem =
  match catalog { | Observed(c) => pricesProblem(environment, c.plus, c.pro) | NoCatalog => CatalogMissing }
pure val observedValues: Set[ProviderPrice] = {
  val plus: ProviderPrice = { active: true, productActive: true, currency: Usd, amountCents: 3000, interval: OneMonth, usage: Licensed, perUnit: true, trial: false, sameProduct: true, livemode: true }
  Set(plus).union(Set({ ...plus, amountCents: 10000 })).union(Set({ ...plus, livemode: false })).union(Set({ ...plus, trial: true })).union(Set({ ...plus, currency: OtherCurrency }))
}
pure val catalogValues: Set[CatalogObservation] = {
  val plus: ProviderPrice = { active: true, productActive: true, currency: Usd, amountCents: 3000, interval: OneMonth, usage: Licensed, perUnit: true, trial: false, sameProduct: true, livemode: true }
  val pro: ProviderPrice = { ...plus, amountCents: 10000 }
  Set(NoCatalog).union(Set(Observed({ plus: plus, pro: pro }))).union(Set(Observed({ plus: { ...plus, livemode: false }, pro: { ...pro, livemode: false } }))).union(Set(Observed({ plus: pro, pro: pro })))
}
pure def lawOnePriceFitsOnePlan(a: PlanKey, b: PlanKey, observed: ProviderPrice, environment: Environment): bool =
  (priceMismatch(a, observed, environment) == NoMismatch and priceMismatch(b, observed, environment) == NoMismatch) implies a == b
pure def lawAPriceFitsOneEnvironmentOnly(key: PlanKey, observed: ProviderPrice): bool =
  not(priceMismatch(key, observed, Production) == NoMismatch and priceMismatch(key, observed, Staging) == NoMismatch)
```

## Story: Answer only the deployment's own callers

> As the owner of an account, I want the cloud to answer my browser and app
> with my session only from the deployment's own pages, and to say plainly
> when a service is not offered, so that no other site acts with my session
> and my app knows what it cannot use.

### A route of a capability the environment does not enable answers 404 capability_unavailable before its body is read

Inference gates chat completions and models; speech gates batch speech and
the realtime relay; maps gates maps; managedGoogle gates the Google routes and
their callback; billing gates subscriptions, the billing snapshot, the
entitlement and its keys, grant redemption, invoices and the provider webhook.
Identity, native clients, public service routes and return pages are ungated.
Text inference needs no other capability.

```quint
type RouteGate = Ungated | Gated({ capability: Capability })
pure def routeOpen(offered: Set[Capability], gate: RouteGate): bool = match gate { | Gated(g) => offered.contains(g.capability) | Ungated => true }
pure val capabilityRefusal: Refusal = refuse(CapabilityUnavailable)
pure val gateValues = Set(Ungated, Gated({ capability: Inference }), Gated({ capability: Maps }), Gated({ capability: Billing }))
pure def lawEnablingACapabilityNeverClosesARoute(offered: Set[Capability], extra: Set[Capability], gate: RouteGate): bool =
  routeOpen(offered, gate) implies routeOpen(offered.union(extra), gate)
```

### The entitlement names the enabled capabilities in one fixed order

The entitlement's `services` claim (`spec/cloud/billing/entitlements.md`) is
this list, rendered as `inference`, `speech`, `maps`, `managedGoogle`,
`billing`; its issuer is the API origin and its audience the environment's.

```quint
pure val capabilityOrder: List[Capability] = List(Inference, Speech, Maps, ManagedGoogle, Billing)
pure def enabledServices(row: EnvironmentProfile): List[Capability] = capabilityOrder.select(c => row.capabilities.contains(c))
pure def lawServicesListEachEnabledCapabilityOnce(offered: Set[Capability], c: Capability): bool =
  capabilityOrder.select(x => offered.contains(x) and x == c).length() == (if (offered.contains(c)) 1 else 0)
```

### A credentialed cross-origin request is answered only for an exact first-party origin of the environment

A request whose `Origin` is in the environment's `firstPartyOrigins` gets
that origin reflected with credentials allowed; any other origin gets no CORS
grant, never a wildcard. A request without `Origin` (a native client) needs
none. A preflight admits only the listed request headers and an answer exposes
only the listed response headers; methods are `GET`, `POST`, `PATCH`,
`DELETE`.

```quint
type RequestOrigin = NoOrigin | FromOrigin({ origin: str })
type CorsGrant = NoCorsGrant | CredentialedGrant
pure def corsGrant(row: EnvironmentProfile, requestOrigin: RequestOrigin): CorsGrant =
  match requestOrigin { | FromOrigin(o) => if (row.firstPartyOrigins.includes(o.origin)) CredentialedGrant else NoCorsGrant | NoOrigin => NoCorsGrant }
pure val allowedRequestHeaders: List[str] = List("Authorization", "Idempotency-Key", "If-Match", "X-Request-ID", "Traceparent", "Tracestate", "Content-Type")
pure val exposedResponseHeaders: List[str] = List("X-Request-Id", "ETag", "Retry-After", "X-Eliza-Speech-Extend", "X-Eliza-TTS-Provider", "X-Eliza-STT-Provider", "X-Eliza-TTS-Speed", "X-Eliza-TTS-Timing")
pure def lawNoCredentialsAcrossEnvironments(p: Profile, environment: Environment): bool =
  profileAccepted(p) implies corsGrant(rowOf(p, environment), FromOrigin({ origin: rowOf(p, otherEnvironment(environment)).web })) == NoCorsGrant
```

### A sign-in method is offered only when its adapter is configured

`GET /api/v1/auth/methods` answers `{email, sms, google}`. Email needs a mail
adapter, SMS an SMS adapter, Google configured Google clients. A route of a
method not offered is refused for good: Google as `503 provider_unavailable`
with reason `google_not_configured` (the registry's config read says the
same), email and SMS as `404 capability_unavailable`.

```quint
type MethodsAnswer = { email: bool, sms: bool, google: bool }
pure def methodOffered(setup: SignInSetup, m: SignInMethod): bool =
  if (m == EmailSignIn) setup.mail != NoDelivery else if (m == PhoneSignIn) setup.sms != NoDelivery else setup.google == GoogleOn
pure def methodsAnswer(setup: SignInSetup): MethodsAnswer = { email: methodOffered(setup, EmailSignIn), sms: methodOffered(setup, PhoneSignIn), google: methodOffered(setup, GoogleSignIn) }
pure def methodRefusal(m: SignInMethod): Refusal = if (m == GoogleSignIn) refuseFor(ProviderUnavailable, GoogleNotConfigured) else capabilityRefusal
pure def lawAMissingMethodIsRefusedForGood(m: SignInMethod): bool = wellFormed(methodRefusal(m)) and not(retryableOf(methodRefusal(m)))
```

### The public service document is the environment's name, terms and privacy, served no-store

`GET /api/public/service` answers `{success: true, version: 1, service:
{name, terms, privacy}}` with `Cache-Control: no-store`; each document is
`{title, revision, sections: [{title, paragraphs}]}` of plain text, complete
as the profile rule requires, because the products' parser refuses an empty
title, section list or paragraph. `GET /api/health` answers without reading
any store.

```quint
type ServiceDocument = { name: str, terms: LegalDocument, privacy: LegalDocument }
pure val serviceDocumentVersion = 1
pure def serviceDocument(row: EnvironmentProfile): ServiceDocument = { name: row.name, terms: row.terms, privacy: row.privacy }
```

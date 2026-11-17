# Deployment profile

A branded deployment of the cloud is described by one reviewed profile: the
origins, tenant and entitlement audience of its production and staging
environments, the native clients it registers, its payment catalog and the
capabilities it enables. The values belong to the deployment and stay with
it; this spec states what any profile must satisfy before a build, a device
or a server uses it.

## Story: Configure a branded cloud from one reviewed profile

> As the operator of a branded deployment, I describe production and
> staging once, and every build, device and server derives its origins,
> tenant, stored-credential namespace and sign-in registration from that
> description, so that no component trusts an authority the profile does
> not name.

### A profile names exactly production and staging, each with canonical HTTPS origins, a valid tenant and audience, and its own API origin

The API, web and services origins are HTTPS origins with no path, no
credentials and the default port; the API and web origins are DNS host
names. The tenant identifier is 1 to 64 letters, digits, `-` or `_`; the
entitlement audience is 1 to 128 letters, digits, `.`, `_` or `-`; a display
name, when given, is trimmed, at most 80 characters and has no control or
format characters. Each environment names the mail sender its sign-in
mail comes from, a valid address of the deployment's own; there is no
default sender. Production and staging use distinct API origins, so a
staging build can never reach the production API by configuration alone.

Everything else derives from the profile. Each registered native client
names its environment, a non-empty package identifier and a clean display
name, and returns only to the profile's callback path on that environment's
web origin. An agent's base for cloud inference and services is the API
origin of the environment it was built for, never a second authority. A
route of a capability the profile does not enable answers that it is not
available, without reading the request further; each area's routes belong
to one capability: inference, agent hosting with its shared runtime and
background jobs, speech, maps, managed Google, billing (credits,
subscriptions and entitlements), hosted backups, remote pairing,
command-line login, object storage, provider connections and document
interpretation.

```quint
type Environment = Production | Staging
type OriginEvidence = { https: bool, canonical: bool, credentialFree: bool, defaultPort: bool, dnsHost: bool }
type EnvironmentRow = { api: str, web: str, services: str, tenant: str, audience: str, mailSender: str, apiOrigin: OriginEvidence, webOrigin: OriginEvidence, servicesOrigin: OriginEvidence, tenantValid: bool, audienceValid: bool, nameValid: bool, mailSenderValid: bool }
type Profile = { exactEnvironments: bool, production: EnvironmentRow, staging: EnvironmentRow, callbackPath: str }
pure def originValid(o: OriginEvidence, needsDnsHost: bool): bool = o.https and o.canonical and o.credentialFree and o.defaultPort and (not(needsDnsHost) or o.dnsHost)
pure def rowValid(r: EnvironmentRow): bool = originValid(r.apiOrigin, true) and originValid(r.webOrigin, true) and originValid(r.servicesOrigin, false) and r.tenantValid and r.audienceValid and r.nameValid and r.mailSender != "" and r.mailSenderValid
pure val goodOrigin: OriginEvidence = { https: true, canonical: true, credentialFree: true, defaultPort: true, dnsHost: true }
pure val productionRow: EnvironmentRow = { api: "https://api.one", web: "https://www.one", services: "https://agents.one", tenant: "tenant-one", audience: "cloud-subscription", mailSender: "sign-in@mail.one", apiOrigin: goodOrigin, webOrigin: goodOrigin, servicesOrigin: goodOrigin, tenantValid: true, audienceValid: true, nameValid: true, mailSenderValid: true }
pure val stagingRow: EnvironmentRow = { ...productionRow, api: "https://api.staging.one", web: "https://www.staging.one", services: "https://agents.staging.one" }
pure val sampleProfile: Profile = { exactEnvironments: true, production: productionRow, staging: stagingRow, callbackPath: "/auth/native/callback" }
pure val pValues = Set(
  sampleProfile,
  { ...sampleProfile, staging: { ...stagingRow, api: "https://api.one" } },
  { ...sampleProfile, production: { ...productionRow, apiOrigin: { ...goodOrigin, credentialFree: false } } },
  { ...sampleProfile, exactEnvironments: false },
  { ...sampleProfile, staging: { ...stagingRow, mailSender: "" } })
pure def profileValid(p: Profile): bool = p.exactEnvironments and rowValid(p.production) and rowValid(p.staging) and p.production.api != p.staging.api
pure def lawSharedApiOriginRefused(p: Profile): bool = p.production.api == p.staging.api implies not(profileValid(p))
pure def lawProfileWithoutAMailSenderRefused(p: Profile): bool = (p.production.mailSender == "" or p.staging.mailSender == "") implies not(profileValid(p))
type Redirect = { origin: str, path: str }
type NativeRegistration = { environment: Environment, packageId: str, displayNameClean: bool, redirect: Redirect }
pure def rowOf(p: Profile, e: Environment): EnvironmentRow = if (e == Production) p.production else p.staging
pure def registrationValid(p: Profile, reg: NativeRegistration): bool =
  profileValid(p) and reg.packageId != "" and reg.displayNameClean and reg.redirect == { origin: rowOf(p, reg.environment).web, path: p.callbackPath }
pure def agentBaseAccepted(p: Profile, e: Environment, base: str): bool = profileValid(p) and base == rowOf(p, e).api
type Capability = InferenceCapability | AgentHostingCapability | SpeechCapability | MapsCapability | ManagedGoogleCapability | BillingCapability | BackupsCapability | RemotePairingCapability | CliLoginCapability | StorageCapability | ConnectionsCapability | DocumentsCapability
pure def routeAdmitted(offered: Set[Capability], c: Capability): bool = offered.contains(c)
```

### Credentialed cross-origin calls are answered only for the deployment's own first-party origins

A browser or app web view that calls the API with credentials is answered
with its own origin reflected and credentials allowed only when that origin
is first party: a web origin of the profile, or the document origin of an
app's web view (`https://localhost` and the app schemes `capacitor`,
`capacitor-electron`, `app`, `tauri`, `file` and `electrobun`). A loopback
origin is first party everywhere but production. Any other origin gets no
credentials: on the public token-authenticated paths, such as chat
completions and speech, it is allowed as any origin without credentials,
and elsewhere it is not allowed at all. A wildcard never carries
credentials. A first-party preflight is allowed the methods GET, POST,
PUT, PATCH, DELETE and OPTIONS and the headers a client sends, among them
`Content-Type`, `Authorization`, `Cache-Control`, `Idempotency-Key`,
`X-Request-ID`, `Traceparent` and `Tracestate`. A deployment whose profile
is incomplete admits no first-party origin rather than another
deployment's.

```quint
type OriginClass = ProfileWebOrigin | AppWebViewOrigin | LoopbackOrigin | ForeignOrigin
type AllowedOrigin = ReflectedOrigin | AnyOrigin | NoOrigin
type CorsAnswer = { allowed: AllowedOrigin, credentials: bool }
type CorsRequest = { origin: OriginClass, environment: Environment, publicTokenPath: bool, profileComplete: bool }
pure def firstParty(corsRequest: CorsRequest): bool =
  corsRequest.profileComplete and (corsRequest.origin == ProfileWebOrigin or corsRequest.origin == AppWebViewOrigin or (corsRequest.origin == LoopbackOrigin and corsRequest.environment != Production))
pure def corsAnswer(corsRequest: CorsRequest): CorsAnswer =
  if (firstParty(corsRequest)) { allowed: ReflectedOrigin, credentials: true }
  else if (corsRequest.publicTokenPath) { allowed: AnyOrigin, credentials: false }
  else { allowed: NoOrigin, credentials: false }
type ClientHeader = ContentTypeHeader | AuthorizationHeader | CacheControlHeader | IdempotencyKeyHeader | RequestIdHeader | TraceparentHeader | TracestateHeader | UndeclaredHeader
pure val firstPartyHeaders: List[ClientHeader] = List(ContentTypeHeader, AuthorizationHeader, CacheControlHeader, IdempotencyKeyHeader, RequestIdHeader, TraceparentHeader, TracestateHeader)
pure def preflightAllowsHeader(header: ClientHeader): bool = firstPartyHeaders.includes(header)
pure val corsRequestValues = Set(
  { origin: ProfileWebOrigin, environment: Production, publicTokenPath: false, profileComplete: true },
  { origin: AppWebViewOrigin, environment: Production, publicTokenPath: true, profileComplete: true },
  { origin: LoopbackOrigin, environment: Production, publicTokenPath: false, profileComplete: true },
  { origin: LoopbackOrigin, environment: Staging, publicTokenPath: false, profileComplete: true },
  { origin: ForeignOrigin, environment: Staging, publicTokenPath: true, profileComplete: true },
  { origin: ForeignOrigin, environment: Production, publicTokenPath: false, profileComplete: true },
  { origin: ProfileWebOrigin, environment: Staging, publicTokenPath: false, profileComplete: false })
pure def lawCredentialsOnlyForAFirstPartyOrigin(corsRequest: CorsRequest): bool = corsAnswer(corsRequest).credentials iff firstParty(corsRequest)
pure def lawAWildcardNeverCarriesCredentials(corsRequest: CorsRequest): bool = corsAnswer(corsRequest).allowed == AnyOrigin implies not(corsAnswer(corsRequest).credentials)
pure def lawLoopbackIsNeverFirstPartyInProduction(corsRequest: CorsRequest): bool =
  (corsRequest.origin == LoopbackOrigin and corsRequest.environment == Production) implies not(corsAnswer(corsRequest).credentials)
pure def lawIncompleteProfileAdmitsNoFirstParty(corsRequest: CorsRequest): bool = not(corsRequest.profileComplete) implies not(corsAnswer(corsRequest).credentials)
pure def lawClientHeadersPassThePreflight(header: ClientHeader): bool = preflightAllowsHeader(header) iff header != UndeclaredHeader
```

### Stored credentials are namespaced by every authority of both environments

A device keeps its cloud credentials under a namespace derived from the API,
web and services origins, tenant and audience of both environments (the
deployment publishes a digest of that tuple). Changing any authority, even one of staging alone, moves
the namespace, so credentials stored for the old authorities are no longer
read. A deployment that changes the namespace must ship a migration for the
credentials already on devices.

```quint
pure def authorities(r: EnvironmentRow): List[str] = List(r.api, r.web, r.services, r.tenant, r.audience)
pure def storageNamespace(p: Profile): List[str] = authorities(p.production).concat(authorities(p.staging))
pure def credentialReadable(stored: List[str], p: Profile): bool = stored == storageNamespace(p)
pure val apiValues = Set("https://api.one", "https://api.staging.one", "https://api.two")
pure def lawStagingChangeRetiresStoredCredentials(p: Profile, api: str): bool =
  api != p.staging.api implies not(credentialReadable(storageNamespace(p), { ...p, staging: { ...p.staging, api: api } }))
pure def lawUnchangedProfileKeepsCredentials(p: Profile): bool = credentialReadable(storageNamespace(p), p)
```

## Story: Release a payment catalog all at once or not at all

> As the operator, I release an environment's payment-provider catalog as
> one immutable input, so that an environment never charges against a
> partial catalog or a catalog of the wrong mode.

### A catalog is released only when it is blank, or complete in the environment's mode and validated with the provider

Staging takes a complete test-mode catalog and production a complete
live-mode one. A partial catalog, a catalog of the other mode, a catalog
the provider did not validate, or invalid optional bindings are refused
before anything is submitted. A prepared release has queued every binding
of its catalog and applied none.

```quint
type Catalog = CatalogBlank | CatalogPartial | CatalogTest | CatalogLive
type ReleasePhase = ReleaseDraft | ReleaseRefused | ReleasePrepared | ReleaseUncertain | ReleaseComplete | ReleaseFailed | ReleaseCancelled
type CatalogRelease = { environment: Environment, catalog: Catalog, providerValid: bool, extrasValid: bool, extraCount: int, phase: ReleasePhase, queued: int, applied: int }
pure val catalogBindings = 5
pure val initial: CatalogRelease = { environment: Staging, catalog: CatalogBlank, providerValid: false, extrasValid: true, extraCount: 0, phase: ReleaseDraft, queued: 0, applied: 0 }
pure def modeCatalog(e: Environment): Catalog = if (e == Production) CatalogLive else CatalogTest
pure def catalogAllowed(r: CatalogRelease): bool = (r.catalog == CatalogBlank or (r.catalog == modeCatalog(r.environment) and r.providerValid)) and r.extrasValid
pure def intendedBindings(r: CatalogRelease): int = (if (r.catalog == CatalogBlank) 0 else catalogBindings) + r.extraCount
pure def canConfigure(r: CatalogRelease, extraCount: int): bool = r.phase == ReleaseDraft and extraCount >= 0
pure def configure(r: CatalogRelease, environment: Environment, catalog: Catalog, providerValid: bool, extrasValid: bool, extraCount: int): CatalogRelease =
  { ...r, environment: environment, catalog: catalog, providerValid: providerValid, extrasValid: extrasValid, extraCount: extraCount }
pure val extraCountValues = Set(0, 1, 2)
pure def canPrepare(r: CatalogRelease): bool = r.phase == ReleaseDraft
pure def prepare(r: CatalogRelease): CatalogRelease =
  if (catalogAllowed(r)) { ...r, phase: ReleasePrepared, queued: intendedBindings(r) } else { ...r, phase: ReleaseRefused }
pure def alwaysOnlyValidatedCatalogIsQueued(r: CatalogRelease): bool = (r.queued > 0 or r.applied > 0) implies catalogAllowed(r)
pure def alwaysRefusalChangesNothing(r: CatalogRelease): bool = ((r.phase == ReleaseDraft or r.phase == ReleaseRefused) implies (r.queued == 0 and r.applied == 0)) and (r.phase == ReleaseCancelled implies r.applied == 0)
pure def alwaysPreparedReleaseQueuesTheWholeCatalog(r: CatalogRelease): bool =
  r.phase == ReleasePrepared implies (r.queued == intendedBindings(r) and r.applied == 0)
pure def sometimesPartialCatalogRefused(r: CatalogRelease): bool = r.phase == ReleaseRefused and r.catalog == CatalogPartial
```

### The provider applies every queued binding or none, and an unknown outcome is settled by reading it back

The submission can lose its reply. The provider changes all named bindings
or none; a read-only observation then settles the release as complete or
failed. A prepared release may still be cancelled before submission.

```quint
pure def canSubmit(r: CatalogRelease): bool = r.phase == ReleasePrepared
pure def submit(r: CatalogRelease, appliedAll: bool): CatalogRelease = { ...r, phase: ReleaseUncertain, applied: if (appliedAll) r.queued else 0 }
pure def canObserve(r: CatalogRelease): bool = r.phase == ReleaseUncertain
pure def observe(r: CatalogRelease): CatalogRelease = { ...r, phase: if (r.applied == r.queued) ReleaseComplete else ReleaseFailed }
pure def canCancel(r: CatalogRelease): bool = r.phase == ReleasePrepared
pure def cancel(r: CatalogRelease): CatalogRelease = { ...r, phase: ReleaseCancelled }
pure def alwaysPublicationIsAtomic(r: CatalogRelease): bool = r.applied == 0 or r.applied == intendedBindings(r)
pure def sometimesTestCatalogPublished(r: CatalogRelease): bool = r.phase == ReleaseComplete and r.catalog == CatalogTest and r.applied > 0
pure def sometimesLiveCatalogPublished(r: CatalogRelease): bool = r.phase == ReleaseComplete and r.catalog == CatalogLive and r.environment == Production
```

### A started release always settles when preparation, submission and observation run

```quint
pure val fair_prepare = "weak"
pure val fair_submit = "weak"
pure val fair_observe = "weak"
pure def releaseSettled(r: CatalogRelease): bool = r.phase == ReleaseRefused or r.phase == ReleaseComplete or r.phase == ReleaseFailed or r.phase == ReleaseCancelled
pure def leadsToReleaseSettled(r: CatalogRelease, later: CatalogRelease): bool = r.phase != ReleaseDraft implies releaseSettled(later)
```

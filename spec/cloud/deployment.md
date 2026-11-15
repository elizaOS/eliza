# Deployment profile

A branded deployment of the cloud is described by one reviewed profile: the
origins, tenant and entitlement audience of its production and staging
environments, the native clients it registers, its payment catalog and the
capabilities it enables. The values belong to the deployment and stay with
it; this spec states what any profile must satisfy before a build, a device
or a server uses it. Validation, the credential storage namespace and the
native-client callback registration follow the develop deployment check;
the catalog release follows `StagingStripeBindings.qnt`.

## Story: Configure a branded cloud from one reviewed profile

> As the operator of a branded deployment, I describe production and
> staging once, and every build, device and server derives its origins,
> tenant, stored-credential namespace and sign-in registration from that
> description, so that no component trusts an authority the profile does
> not name.

### A profile names exactly production and staging, each with canonical HTTPS origins, a valid tenant and a valid audience

The API, web and services origins are HTTPS origins with no path, no
credentials and the default port; the API and web origins are DNS host
names. The tenant identifier is 1 to 64 letters, digits, `-` or `_`; the
entitlement audience is 1 to 128 letters, digits, `.`, `_` or `-`; a display
name, when given, is trimmed, at most 80 characters and has no control or
format characters. URL parsing and pattern matching are boundary evidence.

```quint
type Environment = Production | Staging
type OriginEvidence = { https: bool, canonical: bool, credentialFree: bool, defaultPort: bool, dnsHost: bool }
type EnvironmentRow = { api: str, web: str, services: str, tenant: str, audience: str, apiOrigin: OriginEvidence, webOrigin: OriginEvidence, servicesOrigin: OriginEvidence, tenantValid: bool, audienceValid: bool, nameValid: bool }
type Profile = { exactEnvironments: bool, production: EnvironmentRow, staging: EnvironmentRow, callbackPath: str }
pure def originValid(o: OriginEvidence, needsDnsHost: bool): bool = o.https and o.canonical and o.credentialFree and o.defaultPort and (not(needsDnsHost) or o.dnsHost)
pure def rowValid(r: EnvironmentRow): bool = originValid(r.apiOrigin, true) and originValid(r.webOrigin, true) and originValid(r.servicesOrigin, false) and r.tenantValid and r.audienceValid and r.nameValid
pure def rowOf(p: Profile, e: Environment): EnvironmentRow = if (e == Production) p.production else p.staging
pure val goodOrigin: OriginEvidence = { https: true, canonical: true, credentialFree: true, defaultPort: true, dnsHost: true }
pure val productionRow: EnvironmentRow = { api: "https://api.one", web: "https://www.one", services: "https://agents.one", tenant: "tenant-one", audience: "cloud-subscription", apiOrigin: goodOrigin, webOrigin: goodOrigin, servicesOrigin: goodOrigin, tenantValid: true, audienceValid: true, nameValid: true }
pure val stagingRow: EnvironmentRow = { ...productionRow, api: "https://api.staging.one", web: "https://www.staging.one", services: "https://agents.staging.one" }
pure val sampleProfile: Profile = { exactEnvironments: true, production: productionRow, staging: stagingRow, callbackPath: "/auth/native/callback" }
pure val pValues = Set(
  sampleProfile,
  { ...sampleProfile, staging: { ...stagingRow, api: "https://api.one" } },
  { ...sampleProfile, production: { ...productionRow, apiOrigin: { ...goodOrigin, credentialFree: false } } },
  { ...sampleProfile, exactEnvironments: false })
pure def lawValidRowUsesHttps(p: Profile, e: Environment): bool = rowValid(rowOf(p, e)) implies rowOf(p, e).apiOrigin.https and rowOf(p, e).webOrigin.https
```

### Production and staging use distinct API origins

A staging build can never reach the production API by configuration alone.

```quint
pure def profileValid(p: Profile): bool = p.exactEnvironments and rowValid(p.production) and rowValid(p.staging) and p.production.api != p.staging.api
pure def lawSharedApiOriginRefused(p: Profile): bool = p.production.api == p.staging.api implies not(profileValid(p))
```

### Stored credentials are namespaced by every authority of both environments

A device keeps its cloud credentials under a namespace derived from the API,
web and services origins, tenant and audience of both environments; the
deployment publishes a digest of that tuple, which the model represents by
the tuple itself. Changing any authority, even one of staging alone, moves
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

### A registered native client returns only to the exact callback on its environment's web origin

Each registered native client names its environment, a non-empty package
identifier and a clean display name; its redirect is the profile's callback
path on that environment's web origin and nothing else.

```quint
type Redirect = { origin: str, path: str }
type NativeRegistration = { environment: Environment, packageId: str, displayNameClean: bool, redirect: Redirect }
pure def registrationValid(p: Profile, c: NativeRegistration): bool =
  profileValid(p) and c.packageId != "" and c.displayNameClean and c.redirect.origin == rowOf(p, c.environment).web and c.redirect.path == p.callbackPath
pure val cValues = Set(
  { environment: Production, packageId: "client.one", displayNameClean: true, redirect: { origin: "https://www.one", path: "/auth/native/callback" } },
  { environment: Staging, packageId: "client.one", displayNameClean: true, redirect: { origin: "https://www.one", path: "/auth/native/callback" } },
  { environment: Production, packageId: "", displayNameClean: true, redirect: { origin: "https://www.one", path: "/auth/native/callback" } },
  { environment: Production, packageId: "client.one", displayNameClean: true, redirect: { origin: "https://www.one", path: "/other" } })
pure def lawRedirectIsExact(p: Profile, c: NativeRegistration): bool =
  registrationValid(p, c) implies c.redirect == { origin: rowOf(p, c.environment).web, path: p.callbackPath }
```

### An agent's cloud base is the configured API origin of its environment

The base an agent uses for cloud inference and services is the API origin
of the environment it was built for, never a second authority.

```quint
pure def agentBaseAccepted(p: Profile, e: Environment, base: str): bool = profileValid(p) and base == rowOf(p, e).api
pure val baseValues = Set("https://api.one", "https://api.staging.one", "https://elsewhere.one")
pure def lawAgentBaseIsConfiguredApi(p: Profile, e: Environment, base: str): bool = agentBaseAccepted(p, e, base) implies base == rowOf(p, e).api
```

### A capability the profile does not enable refuses its routes

The profile lists the capabilities the deployment offers. A route of any
other capability answers that it is not available, without reading the
request further.

```quint
type Capability = InferenceCapability | AgentHostingCapability | SpeechCapability | MapsCapability | ManagedGoogleCapability | BillingCapability | BackupsCapability | RemotePairingCapability | CliLoginCapability
pure def routeAdmitted(offered: Set[Capability], c: Capability): bool = offered.contains(c)
pure val offeredValues = Set(Set(), Set(InferenceCapability, BillingCapability), Set(SpeechCapability))
pure def lawDisabledCapabilityRefused(offered: Set[Capability], c: Capability): bool = not(offered.contains(c)) implies not(routeAdmitted(offered, c))
```

## Story: Release a payment catalog all at once or not at all

> As the operator, I release an environment's payment-provider catalog as
> one immutable input, so that an environment never charges against a
> partial catalog or a catalog of the wrong mode.

### A catalog is released only when it is blank, or complete in the environment's mode and validated with the provider

Staging takes a complete test-mode catalog and production a complete
live-mode one. A partial catalog, a catalog of the other mode, a catalog
the provider did not validate, or invalid optional bindings are refused
before anything is submitted.

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

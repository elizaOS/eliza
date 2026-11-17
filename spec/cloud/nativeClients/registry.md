# Registered native clients

A native client is an installed Android application the operator registered
with one environment of the deployment: its client id, its exact return URLs,
its Android package and signing certificates, and the lifetime of the device
keys it receives. Every native entry point reads the same registration, the
config read describes it to the app, and `/.well-known/assetlinks.json`
publishes its Android association. Sources are develop
`packages/cloud/shared/src/lib/services/mobile-client-registry.ts`,
`mobile-app-auth.ts` (`admitMobileAppAuthRegistration`,
`validateMobileAppAuthClientBinding`), `lib/auth/android-asset-links.ts`,
`api/v1/app-auth/mobile/config/route.ts` and the Quint model
`quint/MobileAppClientRegistration.qnt`; downstream readers are the products'
registration, asset-link and readiness scripts and their sign-in plugins.

This library has no state. Registrations live in the environment's own
database and change only through `elizaos-cloud client register|update|disable`
(`spec/cloud/operator.md`). Their Effect Schema owns every string format: a
client id and an Android package are reverse-DNS names, a fingerprint is 32
upper-case colon-separated hex bytes, a display name is trimmed and at most 80
characters, and a return URL is an HTTPS origin and path with no credentials,
query, fragment or wildcard, kept as `{origin, path}` so that two URLs are
equal exactly when their records are. A request whose registry cannot be read
is answered `503 service_unavailable`, retryable; nothing here sees that case.

## Story: Admit only a registered native client

> As the operator of a deployment, I want every native sign-in, checkout,
> Google connection and return page to admit only an app I registered, with
> its exact return addresses, so that no other app can obtain a key or a
> result in its name.

### A registration names one client of one environment, its exact returns, its Android signers and a key lifetime from one to ninety days

The sign-in, billing and optional connect returns are three different URLs. A
registration names one to four distinct certificate fingerprints, so that a
signing-key rotation can keep the previous certificate. The operator may omit
the lifetime; the command then registers the thirty-day default.

```quint
import types.* from "../shared/types"
import deployment.* from "../deployment"
type ReturnUrl = { origin: str, path: str }
type ConnectReturn = NoConnectReturn | ConnectsTo({ url: ReturnUrl })
type Registration = { clientId: str, environment: Environment, displayName: str, signInReturn: ReturnUrl, billingReturn: ReturnUrl, connectReturn: ConnectReturn, androidPackage: str, certFingerprints: List[str], credentialTtl: Millis, nativeGoogle: bool, enabled: bool }
pure val minCredentialTtl: Millis = millisPerDay
pure val maxCredentialTtl: Millis = 90 * millisPerDay
pure val defaultCredentialTtl: Millis = 30 * millisPerDay
pure val maxCertFingerprints = 4
pure def connectUrls(connect: ConnectReturn): List[ReturnUrl] = match connect { | ConnectsTo(c) => List(c.url) | NoConnectReturn => List() }
pure def returnsOf(r: Registration): List[ReturnUrl] = List(r.signInReturn, r.billingReturn).concat(connectUrls(r.connectReturn))
pure def registrationValid(r: Registration): bool =
  r.clientId != "" and r.displayName != "" and r.androidPackage != ""
  and r.certFingerprints.length() >= 1 and r.certFingerprints.length() <= maxCertFingerprints
  and r.certFingerprints.every(f => r.certFingerprints.select(g => g == f).length() == 1)
  and r.credentialTtl >= minCredentialTtl and r.credentialTtl <= maxCredentialTtl
  and returnsOf(r).every(u => returnsOf(r).select(v => v == u).length() == 1)
pure val rValues: Set[Registration] = {
  val one: Registration = { clientId: "app.one", environment: Production, displayName: "One", signInReturn: { origin: "https://www.one", path: "/one/auth" }, billingReturn: { origin: "https://www.one", path: "/one/billing" }, connectReturn: ConnectsTo({ url: { origin: "https://www.one", path: "/one/connect" } }), androidPackage: "app.one", certFingerprints: List("AA"), credentialTtl: 2592000000, nativeGoogle: true, enabled: true }
  val two: Registration = { ...one, clientId: "app.two", androidPackage: "app.two", signInReturn: { origin: "https://two.example", path: "/auth" }, billingReturn: { origin: "https://two.example", path: "/billing" }, connectReturn: NoConnectReturn, certFingerprints: List("BB", "CC"), nativeGoogle: false }
  Set(one, two, { ...two, enabled: false }, { ...one, environment: Staging }, { ...one, credentialTtl: 1000 }, { ...one, billingReturn: one.signInReturn })
}
```

### No two registrations of a registry share a client id, an Android package or a return URL, and all belong to the served environment

Each environment has its own database, so its registry holds only its own
registrations; a product registers the same app in staging and production
separately. Because no return is shared, a return URL names exactly one
registration and one purpose.

```quint
pure def sharesNothing(a: Registration, b: Registration): bool =
  a.clientId != b.clientId and a.androidPackage != b.androidPackage and returnsOf(a).every(u => not(returnsOf(b).includes(u)))
pure def registryValid(registry: List[Registration], served: Environment): bool =
  registry.every(a => a.environment == served and registrationValid(a) and registry.select(b => not(sharesNothing(a, b))).length() == 1)
pure val registryValues: Set[List[Registration]] = {
  val one: Registration = { clientId: "app.one", environment: Production, displayName: "One", signInReturn: { origin: "https://www.one", path: "/one/auth" }, billingReturn: { origin: "https://www.one", path: "/one/billing" }, connectReturn: ConnectsTo({ url: { origin: "https://www.one", path: "/one/connect" } }), androidPackage: "app.one", certFingerprints: List("AA"), credentialTtl: 2592000000, nativeGoogle: true, enabled: true }
  val two: Registration = { ...one, clientId: "app.two", androidPackage: "app.two", signInReturn: { origin: "https://two.example", path: "/auth" }, billingReturn: { origin: "https://two.example", path: "/billing" }, connectReturn: NoConnectReturn, certFingerprints: List("BB", "CC"), nativeGoogle: false, enabled: false }
  Set(List(), List(one), List(one, two), List({ ...one, environment: Staging }), List(one, one), List(one, { ...two, androidPackage: "app.one" }), List(one, { ...two, signInReturn: one.billingReturn }))
}
```

### Only the operator registers, updates or disables a registration, and doing so never changes another client

Registering or updating replaces the registration with the same client id; it
is accepted only when the result is a valid registry and no return lies on
the environment's API origin, which serves no page. Disabling keeps the
registration so that its client id and returns stay reserved.

```quint
pure def withRegistration(registry: List[Registration], r: Registration): List[Registration] = registry.select(x => x.clientId != r.clientId).append(r)
pure def disableClient(registry: List[Registration], clientId: str): List[Registration] = registry.listMap(x => if (x.clientId == clientId) { ...x, enabled: false } else x)
pure def registrationAccepted(registry: List[Registration], row: EnvironmentProfile, served: Environment, r: Registration): bool =
  returnsOf(r).every(u => u.origin != row.api) and registryValid(withRegistration(registry, r), served)
pure val clientIdValues = Set("app.one", "app.two", "app.other")
pure def lawRegisteringNeverChangesAnotherClient(registry: List[Registration], served: Environment, request: ClientRequest, r: Registration): bool =
  request.clientId != r.clientId implies clientCheck(withRegistration(registry, r), served, request) == clientCheck(registry, served, request)
pure def lawDisablingKeepsTheRegistryValid(registry: List[Registration], served: Environment, clientId: str): bool =
  registryValid(registry, served) implies registryValid(disableClient(registry, clientId), served)
```

### Every entry point admits only an enabled registration of the served environment with the exact client id and, where it names a return, that exact return

The config read, connect, token, native Google sign-in and browser Google
sign-in name the sign-in return; a Google connection names the connect return
(without its `state` parameter) or none; checkout, acknowledgement and the
return pages name none, because checkout takes its returns from the
registration and acknowledgement takes the client from its grant. The request
names its environment, which must be the one the instance serves.

```quint
type ReturnPurpose = SignInPurpose | BillingPurpose | ConnectPurpose
type RedirectClaim = NoRedirect | ClaimsReturn({ purpose: ReturnPurpose, url: ReturnUrl })
type ClientRequest = { clientId: str, environment: Environment, redirect: RedirectClaim }
type ClientFault = UnknownClient | DisabledClient | WrongRedirect
type ClientCheck = ClientAdmitted | ClientRefused({ fault: ClientFault })
pure def hasReturn(r: Registration, purpose: ReturnPurpose, url: ReturnUrl): bool =
  if (purpose == SignInPurpose) r.signInReturn == url
  else if (purpose == BillingPurpose) r.billingReturn == url
  else connectUrls(r.connectReturn).includes(url)
pure def redirectFits(r: Registration, claim: RedirectClaim): bool = match claim { | ClaimsReturn(c) => hasReturn(r, c.purpose, c.url) | NoRedirect => true }
pure def registrationsFor(registry: List[Registration], served: Environment, clientId: str): List[Registration] = registry.select(r => r.clientId == clientId and r.environment == served)
pure def clientCheck(registry: List[Registration], served: Environment, request: ClientRequest): ClientCheck = {
  val found = registrationsFor(registry, served, request.clientId)
  if (request.environment != served or found.length() == 0) ClientRefused({ fault: UnknownClient })
  else if (not(found.every(r => r.enabled))) ClientRefused({ fault: DisabledClient })
  else if (not(found.every(r => redirectFits(r, request.redirect)))) ClientRefused({ fault: WrongRedirect })
  else ClientAdmitted
}
pure val requestValues: Set[ClientRequest] = {
  val signIn: ClientRequest = { clientId: "app.one", environment: Production, redirect: ClaimsReturn({ purpose: SignInPurpose, url: { origin: "https://www.one", path: "/one/auth" } }) }
  Set(signIn, { ...signIn, redirect: NoRedirect }, { ...signIn, environment: Staging }, { ...signIn, clientId: "app.two" }, { ...signIn, clientId: "app.other" },
    { ...signIn, redirect: ClaimsReturn({ purpose: SignInPurpose, url: { origin: "https://www.one", path: "/one/billing" } }) },
    { ...signIn, redirect: ClaimsReturn({ purpose: ConnectPurpose, url: { origin: "https://www.one", path: "/one/connect" } }) })
}
pure def lawADisabledClientIsNeverAdmitted(registry: List[Registration], served: Environment, request: ClientRequest): bool =
  clientCheck(disableClient(registry, request.clientId), served, request) != ClientAdmitted
pure def lawNoRequestIsAdmittedInBothEnvironments(registry: List[Registration], request: ClientRequest): bool =
  not(clientCheck(registry, Production, request) == ClientAdmitted and clientCheck(registry, Staging, request) == ClientAdmitted)
```

### A return on the environment's web origin is served by the cloud's return page, and any other by the product's own App Link

`spec/cloud/returnPages.md` serves a request only when its URL is the return
of an enabled registration on the web origin; the product verifies a return
on its own host with its own App Link and serves it itself.

```quint
type ReturnHost = CloudWebOrigin | ProductHost
type ReturnEntry = { registration: Registration, purpose: ReturnPurpose }
pure def returnHost(row: EnvironmentProfile, url: ReturnUrl): ReturnHost = if (url.origin == row.web) CloudWebOrigin else ProductHost
pure def entriesAt(r: Registration, url: ReturnUrl): List[ReturnEntry] =
  List(SignInPurpose, BillingPurpose, ConnectPurpose).select(p => hasReturn(r, p, url)).listMap(p => { registration: r, purpose: p })
pure def returnsAt(registry: List[Registration], served: Environment, url: ReturnUrl): List[ReturnEntry] =
  registry.select(r => r.enabled and r.environment == served).foldl(List(), (acc, r) => acc.concat(entriesAt(r, url)))
pure val urlValues: Set[ReturnUrl] = Set({ origin: "https://www.one", path: "/one/auth" }, { origin: "https://www.one", path: "/one/billing" }, { origin: "https://two.example", path: "/auth" }, { origin: "https://www.one", path: "/none" })
pure def lawAReturnBelongsToOneRegistration(registry: List[Registration], served: Environment, url: ReturnUrl): bool =
  registryValid(registry, served) implies returnsAt(registry, served, url).length() <= 1
```

### The association document holds one handle_all_urls statement per enabled registration

`/.well-known/assetlinks.json`, served on the web and API origins, lists for
each enabled registration of the served environment the relation
`delegate_permission/common.handle_all_urls` with namespace `android_app`, its
Android package and its fingerprints. A disabled registration drops out; no
other relation is published.

```quint
type AssetStatement = { packageName: str, fingerprints: List[str] }
pure def assetStatements(registry: List[Registration], served: Environment): List[AssetStatement] =
  registry.select(r => r.enabled and r.environment == served).listMap(r => { packageName: r.androidPackage, fingerprints: r.certFingerprints })
pure def lawOneStatementPerPackage(registry: List[Registration], served: Environment): bool =
  registryValid(registry, served) implies assetStatements(registry, served).every(s => assetStatements(registry, served).select(t => t.packageName == s.packageName).length() == 1)
```

### The config read describes the admitted registration, the offered methods and whether native Google sign-in is open

`GET /api/v1/app-auth/mobile/config?clientId&environment&redirectUri` is
admitted with the sign-in return and answers `{clientId, environment,
redirectUri, codeChallengeMethod: "S256", credentialTtlMs, methods, google:
{configured, serverClientId, nativeSignIn}}`. With Google off, `configured`
and `nativeSignIn` are false and `serverClientId` is empty.

```quint
type GoogleConfig = { configured: bool, serverClientId: str, nativeSignIn: bool }
type ConfigAnswer = { clientId: str, environment: Environment, redirectUri: ReturnUrl, codeChallengeMethod: str, credentialTtlMs: Millis, methods: MethodsAnswer, google: GoogleConfig }
pure val codeChallengeMethod = "S256"
pure def configAnswer(r: Registration, setup: SignInSetup, serverClientId: str): ConfigAnswer = {
  val configured = methodOffered(setup, GoogleSignIn)
  { clientId: r.clientId, environment: r.environment, redirectUri: r.signInReturn, codeChallengeMethod: codeChallengeMethod, credentialTtlMs: r.credentialTtl, methods: methodsAnswer(setup),
    google: { configured: configured, serverClientId: if (configured) serverClientId else "", nativeSignIn: configured and r.nativeGoogle } }
}
pure val setupValues: Set[SignInSetup] = Set({ mail: HttpsDelivery, sms: HttpsDelivery, google: GoogleOn }, { mail: HttpsDelivery, sms: NoDelivery, google: GoogleOff })
```

## Story: Tell a client exactly why it was refused

> As the developer of a native client, I want a refused sign-in to say
> whether the app is unknown, disabled, using the wrong return or asking for
> a method the cloud does not offer, so that the app shows the right message
> and never retries what cannot succeed.

### An unknown client, a disabled client and a wrong return each have their own code, and none is retryable

An unknown client, including a request for the other environment, is
`400 invalid_client`; a disabled one `403 client_disabled`; a return that is
not the registration's own `400 redirect_mismatch`.

```quint
pure def faultRefusal(fault: ClientFault): Refusal =
  if (fault == UnknownClient) refuse(InvalidClient) else if (fault == DisabledClient) refuse(ClientDisabled) else refuse(RedirectMismatch)
pure def lawAClientRefusalIsFinal(fault: ClientFault): bool = wellFormed(faultRefusal(fault)) and not(retryableOf(faultRefusal(fault)))
pure def lawEachFaultHasItsOwnCode(fault: ClientFault, other: ClientFault): bool = faultRefusal(fault) == faultRefusal(other) implies fault == other
```

### Native Google sign-in is refused as google_not_configured when Google is off, and as invalid_client when the registration does not enable it

`POST /api/v1/app-auth/mobile/google` first admits the client with its
sign-in return, then needs both; neither refusal is retryable.

```quint
type NativeGoogleCheck = NativeGoogleOpen | GoogleNotOffered | NativeGoogleNotRegistered
pure def nativeGoogleCheck(setup: SignInSetup, r: Registration): NativeGoogleCheck =
  if (not(methodOffered(setup, GoogleSignIn))) GoogleNotOffered else if (not(r.nativeGoogle)) NativeGoogleNotRegistered else NativeGoogleOpen
pure def nativeGoogleRefusal(check: NativeGoogleCheck): Refusal = if (check == GoogleNotOffered) methodRefusal(GoogleSignIn) else refuse(InvalidClient)
pure def lawNativeGoogleMatchesTheConfigRead(setup: SignInSetup, r: Registration, serverClientId: str): bool =
  (nativeGoogleCheck(setup, r) == NativeGoogleOpen) iff configAnswer(r, setup, serverClientId).google.nativeSignIn
pure def lawANativeGoogleRefusalIsFinal(check: NativeGoogleCheck): bool =
  check != NativeGoogleOpen implies (wellFormed(nativeGoogleRefusal(check)) and not(retryableOf(nativeGoogleRefusal(check))))
```

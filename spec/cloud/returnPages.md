# Hosted return pages

The cloud hosts two pages and nothing else. ReturnToApp is the page a browser
shows when an Android App Link to a registered return on the environment's
web origin did not open the app; it offers one link that opens the app.
CheckoutOutcome is the page a different payer of a shared checkout lands on.
Neither page signs anyone in, shows an account or takes a payment. Sources
are develop `packages/cloud/shared/src/lib/auth/native-callback-fallback.ts`,
`api/v1/subscriptions/checkout/payer/route.ts` and `api/src/bootstrap-app.ts`
(the return routes); downstream readers are the products' App Link filters,
their Google connection return parser and the shared checkout screen.

This library has no state. The pages are React templates rendered to static
HTML at build time; the shell fills in only the names and the link this spec
decides. The shell reads the registry as `nativeClients/registry` describes:
an unreadable registry answers `503 service_unavailable`, retryable.

## Story: Bring me back to the app when its link did not open

> As a person who just signed in, paid or connected Google in a browser, I
> want a page that takes me back to the app when the app did not open by
> itself, so that I can finish there without seeing or copying anything.

### A return URL on the web origin shows ReturnToApp only for the one enabled registration of the served environment that holds it, and any other address is 404

A return on a product host is the product's to serve; the API origin serves
no return. The page names only the deployment's display name and the
registration's display name: no query or fragment value appears on it. An
address that shows no page is answered `404 not_found`, never retryable.

```quint
import types.* from "./shared/types"
import deployment.* from "./deployment"
import registry.* from "./nativeClients/registry"
type PagePurpose = SignInPage | BillingPage | ConnectPage | ConnectedPage
type AppLink = { target: ReturnUrl, androidPackage: str }
type PageAction = OpenApp({ link: AppLink }) | NoAction
type ReturnPage = { serviceName: str, appName: str, purpose: PagePurpose, offer: PageAction }
type PayerOutcome = PaidOutcome | CanceledOutcome
type Page = NoPage | ReturnToApp(ReturnPage) | CheckoutOutcome({ shown: PayerOutcome })
pure def pagePurposeOf(purpose: ReturnPurpose): PagePurpose =
  if (purpose == SignInPurpose) SignInPage else if (purpose == BillingPurpose) BillingPage else ConnectPage
pure def returnPage(row: EnvironmentProfile, r: Registration, purpose: ReturnPurpose, url: ReturnUrl): Page =
  ReturnToApp({ serviceName: row.name, appName: r.displayName, purpose: pagePurposeOf(purpose), offer: OpenApp({ link: { target: url, androidPackage: r.androidPackage } }) })
pure def pageAt(row: EnvironmentProfile, registry: List[Registration], served: Environment, url: ReturnUrl, reported: str): Page = {
  val entries = returnsAt(registry, served, url)
  if (isPayerUrl(row, url)) CheckoutOutcome({ shown: payerOutcome(reported) })
  else if (url.origin != row.web or entries.length() != 1) NoPage
  else entries.foldl(NoPage, (acc, e) => returnPage(row, e.registration, e.purpose, url))
}
pure def isReturnToApp(page: Page): bool = match page { | ReturnToApp(p) => true | _ => false }
pure def isPayerUrl(row: EnvironmentProfile, url: ReturnUrl): bool = url.origin == row.api and url.path == payerPath
pure val noPageRefusal: Refusal = refuse(NotFound)
pure val rowValues: Set[EnvironmentProfile] = {
  val doc: LegalDocument = { title: "Terms", revision: "1", sections: List({ title: "Use", paragraphs: List("Plain text.") }) }
  Set({ name: "Cloud", api: "https://api.one", web: "https://www.one", audience: "aud", mailSender: "m@one", databaseDigest: "d1", firstPartyOrigins: List("https://www.one"), capabilities: Set(BillingCapability), signIn: { mail: HttpsDelivery, sms: NoDelivery, google: GoogleOn }, terms: doc, privacy: doc })
}
pure def lawReturnToAppExactlyForAnEnabledWebReturn(row: EnvironmentProfile, registry: List[Registration], served: Environment, url: ReturnUrl, reported: str): bool =
  (registryValid(registry, served) and not(isPayerUrl(row, url)))
    implies (isReturnToApp(pageAt(row, registry, served, url, reported)) iff (url.origin == row.web and registry.some(r => r.enabled and returnsOf(r).includes(url))))
pure def lawNoPageIsAFinal404(row: EnvironmentProfile): bool = statusOf(noPageRefusal.code) == 404 and wellFormed(noPageRefusal) and not(retryableOf(noPageRefusal))
```

### The page's one action opens the registered return in the package of the registration that holds it

The link is `intent://<web host><return path>#Intent;scheme=https;package=<androidPackage>;end`,
built by the server from the registration, never from the request. When the
browser cannot open it, the page says to allow the app to open its supported
links in Android settings.

```quint
pure def linkOwned(registry: List[Registration], served: Environment, url: ReturnUrl, offer: PageAction): bool = match offer {
  | OpenApp(o) => o.link.target == url and registry.some(r => r.enabled and r.environment == served and r.androidPackage == o.link.androidPackage and returnsOf(r).includes(url))
  | NoAction => false
}
pure def lawAReturnPageOpensItsOwnApp(row: EnvironmentProfile, registry: List[Registration], served: Environment, url: ReturnUrl, reported: str): bool = {
  val page = pageAt(row, registry, served, url, reported)
  match page { | ReturnToApp(p) => linkOwned(registry, served, url, p.offer) | _ => true }
}
```

### A Google connection finished without a connect return shows ReturnToApp as connected, with no action

`services/google/connection` shows this page at its callback when the
registration names no connect return; with a connect return it redirects
there instead, so this page is never shown.

```quint
pure def connectedPage(row: EnvironmentProfile, r: Registration): Page =
  if (r.enabled and r.connectReturn == NoConnectReturn) ReturnToApp({ serviceName: row.name, appName: r.displayName, purpose: ConnectedPage, offer: NoAction })
  else NoPage
pure def lawAConnectReturnIsNeverShadowed(row: EnvironmentProfile, r: Registration): bool =
  connectUrls(r.connectReturn).length() > 0 implies connectedPage(row, r) == NoPage
```

### The pinned script forwards into the app link only the purpose's well-formed results

Results arrive in the fragment (sign-in, connect) or the query (billing).
The shell's schema reads the first value of each name and checks its
pattern: `state` `[A-Za-z0-9_-]{43}`, `connectionId` `[A-Za-z0-9_-]{1,128}`,
`session_id` `cs_(test|live)_[A-Za-z0-9]{1,200}`, `result` `[a-z]{1,16}`. An
intent link carries no data fragment, so forwarded values go into the link's
query. Sign-in forwards `error=app_link_unverified` with a well-formed
`state`, never a code; connect forwards `state`, `result` and, only for
`connected`, `connectionId`, all or nothing; billing forwards a well-formed
`session_id` and `result`, which are identifiers, not proof of payment.
The script then clears the query and fragment from the address bar; the
page's Bombadil property checks that, and that no element shows a value.

```quint
type ParamValue = MissingValue | MalformedValue | WellFormed({ text: str })
type ReturnParams = { stateParam: ParamValue, resultParam: ParamValue, connectionIdParam: ParamValue, sessionIdParam: ParamValue }
type Forwarded = { name: str, value: str }
pure val connectResults: List[str] = List("connected", "denied", "failed")
pure val billingResults: List[str] = List("success", "cancel")
pure def textOf(v: ParamValue): List[str] = match v { | WellFormed(w) => List(w.text) | _ => List() }
pure def named(name: str, v: ParamValue): List[Forwarded] = textOf(v).listMap(t => { name: name, value: t })
pure def connectForwarded(params: ReturnParams): List[Forwarded] = {
  val result = textOf(params.resultParam)
  val connected = result == List("connected")
  val idFits = if (connected) textOf(params.connectionIdParam).length() == 1 else params.connectionIdParam == MissingValue
  if (textOf(params.stateParam).length() == 1 and result.length() == 1 and connectResults.includes(result.foldl("", (acc, t) => t)) and idFits)
    named("state", params.stateParam).concat(named("result", params.resultParam)).concat(named("connectionId", params.connectionIdParam))
  else List()
}
pure def forwarded(purpose: PagePurpose, params: ReturnParams): List[Forwarded] =
  if (purpose == SignInPage) (if (textOf(params.stateParam).length() == 1) List({ name: "error", value: "app_link_unverified" }).concat(named("state", params.stateParam)) else List())
  else if (purpose == ConnectPage) connectForwarded(params)
  else if (purpose == BillingPage) named("session_id", params.sessionIdParam).concat(textOf(params.resultParam).select(t => billingResults.includes(t)).listMap(t => { name: "result", value: t }))
  else List()
pure val paramsValues: Set[ReturnParams] = {
  val s = WellFormed({ text: "s43" })
  val none: ReturnParams = { stateParam: MissingValue, resultParam: MissingValue, connectionIdParam: MissingValue, sessionIdParam: MissingValue }
  Set(none, { ...none, stateParam: s }, { ...none, stateParam: MalformedValue },
    { ...none, stateParam: s, resultParam: WellFormed({ text: "connected" }), connectionIdParam: WellFormed({ text: "c1" }) },
    { ...none, stateParam: s, resultParam: WellFormed({ text: "connected" }) },
    { ...none, stateParam: s, resultParam: WellFormed({ text: "denied" }) },
    { ...none, stateParam: s, resultParam: WellFormed({ text: "denied" }), connectionIdParam: WellFormed({ text: "c1" }) },
    { ...none, stateParam: s, resultParam: WellFormed({ text: "code" }) },
    { ...none, resultParam: WellFormed({ text: "success" }), sessionIdParam: WellFormed({ text: "cs_test_1" }) },
    { ...none, resultParam: WellFormed({ text: "paid" }), sessionIdParam: MalformedValue })
}
pure def lawForwardsOnlyWellFormedValuesOrTheFixedError(purpose: PagePurpose, params: ReturnParams): bool =
  forwarded(purpose, params).every(f => (f.name == "error" and f.value == "app_link_unverified")
    or (f.name == "state" and textOf(params.stateParam) == List(f.value))
    or (f.name == "result" and textOf(params.resultParam) == List(f.value))
    or (f.name == "connectionId" and textOf(params.connectionIdParam) == List(f.value))
    or (f.name == "session_id" and textOf(params.sessionIdParam) == List(f.value)))
pure def lawConnectForwardsAWholeResultOrNothing(params: ReturnParams): bool = {
  val sent = forwarded(ConnectPage, params)
  sent.length() == 0 or sent.length() == (if (sent.some(f => f.name == "result" and f.value == "connected")) 3 else 2)
}
```

### Every page is private, unframed and unindexed, has no form, and runs at most the pinned script

Each answer carries `Cache-Control: no-store`, `X-Robots-Tag: noindex`,
`Referrer-Policy: no-referrer` and a CSP with `default-src 'none'`,
`form-action 'none'` and `frame-ancestors 'none'`. ReturnToApp's CSP
`script-src` names only the `sha256` of the one pinned script, which the build
computes; CheckoutOutcome has no `script-src`.

```quint
type ScriptPolicy = NoScript | PinnedScript
type PageHeaders = { cacheControl: str, robots: str, referrerPolicy: str, frameAncestors: str, formAction: str, script: ScriptPolicy }
pure def scriptOf(page: Page): ScriptPolicy = if (isReturnToApp(page)) PinnedScript else NoScript
pure def pageHeaders(page: Page): PageHeaders =
  { cacheControl: "no-store", robots: "noindex", referrerPolicy: "no-referrer", frameAncestors: "'none'", formAction: "'none'", script: scriptOf(page) }
```

## Story: Tell a payer the checkout ended

> As someone paying for another person's plan through a shared link, I want
> a page that tells me the checkout ended, so that I know to let them check
> their subscription in the app.

### The payer page on the API origin shows the paid copy only for outcome=paid, the closed copy for anything else, and offers no action

`GET /api/v1/subscriptions/checkout/payer?outcome=` is behind the billing
capability (`deployment`). The page reads nothing but `outcome`, shows no
session, account, plan or payment state, and never claims a payment was
made: the paid copy asks the person to check the subscription in the app,
which shows it once the payment provider confirms it.

```quint
pure val payerPath = "/api/v1/subscriptions/checkout/payer"
pure def payerOutcome(reported: str): PayerOutcome = if (reported == "paid") PaidOutcome else CanceledOutcome
pure val reportedValues = Set("paid", "canceled", "success")
pure def lawThePayerPageReadsOnlyTheOutcome(row: EnvironmentProfile, registry: List[Registration], served: Environment, reported: str): bool =
  pageAt(row, registry, served, { origin: row.api, path: payerPath }, reported) == CheckoutOutcome({ shown: payerOutcome(reported) })
```

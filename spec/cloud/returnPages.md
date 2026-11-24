# Hosted return pages

The cloud hosts two kinds of page and nothing else. ReturnToApp is what a
browser shows when an Android App Link to a registered return on the
environment's web origin did not open the app; it offers one link that opens
the app. CheckoutOutcome is what a different payer of a shared checkout lands
on. Neither page signs anyone in, shows an account or takes a payment. Sources
are develop `packages/cloud/shared/src/lib/auth/native-callback-fallback.ts`,
`api/v1/subscriptions/checkout/payer/route.ts` and `api/src/bootstrap-app.ts`
(the return routes); downstream readers are the products' App Link filters,
their Google connection return parser and the shared checkout screen.

This library has no state. The pages are React templates rendered to static
HTML at build time; the shell fills in only the names and the link this spec
decides, and reads the registry as `nativeClients/registry` describes.

## Story: Bring me back to the app when its link did not open

> As a person who just signed in, paid or connected Google in a browser, I
> want a page that takes me back to the app when the app did not open by
> itself, so that I can finish there without seeing or copying anything.

### A return URL on the web origin shows ReturnToApp only for the one enabled registration of the served environment that holds it

A return on a product host is the product's to serve, and the API origin
serves no return. The page names only the deployment's display name and the
registration's display name: no query or fragment value appears on it.

```quint
import types.* from "./shared/types"
import deployment.* from "./deployment"
import registry.* from "./nativeClients/registry"
type PagePurpose = SignInPage | BillingPage | ConnectPage | ConnectedPage
type AppLink = { target: ReturnUrl, androidPackage: str }
type PageAction = OpenApp({ link: AppLink }) | NoAction
type ReturnPage = { serviceName: str, appName: str, purpose: PagePurpose, offer: PageAction }
type PayerOutcome = PaidOutcome | CanceledOutcome
type Page = ReturnToApp(ReturnPage) | CheckoutOutcome({ shown: PayerOutcome, serviceName: str })
type RegistryRead = UnreadableRegistry | ReadRegistry({ registrations: List[Registration] })
type PageAnswer = Shows({ page: Page }) | Refused({ refusal: Refusal })
pure def pagePurposeOf(purpose: ReturnPurpose): PagePurpose =
  if (purpose == SignInPurpose) SignInPage else if (purpose == BillingPurpose) BillingPage else ConnectPage
pure def returnPage(row: EnvironmentProfile, entry: ReturnEntry, url: ReturnUrl): Page =
  ReturnToApp({ serviceName: row.name, appName: entry.registration.displayName, purpose: pagePurposeOf(entry.purpose), offer: OpenApp({ link: { target: url, androidPackage: entry.registration.androidPackage } }) })
pure val notFoundAnswer: PageAnswer = Refused({ refusal: refuse(NotFound) })
pure def returnAnswer(row: EnvironmentProfile, registry: List[Registration], served: Environment, url: ReturnUrl): PageAnswer = {
  val entries = returnsAt(registry, served, url)
  if (url.origin != row.web or entries.length() != 1) notFoundAnswer
  else entries.foldl(notFoundAnswer, (acc, e) => Shows({ page: returnPage(row, e, url) }))
}
pure def answerAt(row: EnvironmentProfile, read: RegistryRead, served: Environment, url: ReturnUrl, reported: str): PageAnswer =
  if (isPayerUrl(row, url)) payerAnswer(row, reported)
  else match read {
    | ReadRegistry(r) => returnAnswer(row, r.registrations, served, url)
    | UnreadableRegistry => if (url.origin == row.web) Refused({ refusal: refuse(ServiceUnavailable) }) else notFoundAnswer
  }
pure def pageIsReturnToApp(page: Page): bool = match page { | ReturnToApp(p) => true | _ => false }
pure def pageOffers(page: Page): PageAction = match page { | ReturnToApp(p) => p.offer | _ => NoAction }
pure def showsReturnToApp(answer: PageAnswer): bool = match answer { | Shows(s) => pageIsReturnToApp(s.page) | _ => false }
pure def readOf(registry: List[Registration], readable: bool): RegistryRead = if (readable) ReadRegistry({ registrations: registry }) else UnreadableRegistry
pure val rowValues: Set[EnvironmentProfile] = {
  val doc: LegalDocument = { title: "Terms", revision: "1", sections: List({ title: "Use", paragraphs: List("Plain text.") }) }
  val row: EnvironmentProfile = { name: "Cloud", api: "https://api.one", web: "https://www.one", audience: "aud", mailSender: "m@one", databaseDigest: "d1", firstPartyOrigins: List("https://www.one"), capabilities: Set(BillingCapability), signIn: { mail: HttpsDelivery, sms: NoDelivery, google: GoogleOn }, terms: doc, privacy: doc }
  Set(row).union(Set({ ...row, capabilities: Set(InferenceCapability) }))
}
pure def lawReturnToAppExactlyForAnEnabledWebReturn(row: EnvironmentProfile, registry: List[Registration], served: Environment, url: ReturnUrl, reported: str): bool =
  (registryValid(registry, served) and not(isPayerUrl(row, url)))
    implies (showsReturnToApp(answerAt(row, readOf(registry, true), served, url, reported)) iff (url.origin == row.web and registry.some(r => r.enabled and returnsOf(r).includes(url))))
```

### An address that shows no page is a final 404, and a web-origin address whose registry cannot be read is a retryable 503

```quint
pure def lawOnlyAnUnreadableRegistryIsRetryable(row: EnvironmentProfile, registry: List[Registration], readable: bool, served: Environment, url: ReturnUrl, reported: str): bool = {
  val answer = answerAt(row, readOf(registry, readable), served, url, reported)
  match answer {
    | Refused(x) => wellFormed(x.refusal) and statusOf(x.refusal.code) == (if (retryableOf(x.refusal)) 503 else 404)
        and (retryableOf(x.refusal) iff (not(readable) and url.origin == row.web and not(isPayerUrl(row, url))))
    | _ => true
  }
}
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
pure def pageLinkOwned(registry: List[Registration], served: Environment, url: ReturnUrl, page: Page): bool =
  match page { | ReturnToApp(p) => linkOwned(registry, served, url, p.offer) | _ => true }
pure def lawAReturnPageOpensItsOwnApp(row: EnvironmentProfile, registry: List[Registration], served: Environment, url: ReturnUrl, reported: str): bool = {
  val answer = answerAt(row, readOf(registry, true), served, url, reported)
  match answer { | Shows(s) => pageLinkOwned(registry, served, url, s.page) | _ => true }
}
```

### A Google connection finished for an enabled registration without a connect return shows ReturnToApp as connected, with no action

`services/google/connection` shows this page at its callback when the
registration names no connect return; with a connect return it redirects
there instead, so this page is never shown.

A browser connection with no app return shows the same connected page under
the service name, with no action.

```quint
pure def connectedOnCloud(row: EnvironmentProfile): PageAnswer =
  Shows({ page: ReturnToApp({ serviceName: row.name, appName: row.name, purpose: ConnectedPage, offer: NoAction }) })
pure def connectedAnswer(row: EnvironmentProfile, r: Registration): PageAnswer =
  if (r.enabled and r.connectReturn == NoConnectReturn) Shows({ page: ReturnToApp({ serviceName: row.name, appName: r.displayName, purpose: ConnectedPage, offer: NoAction }) })
  else notFoundAnswer
pure def lawAConnectReturnIsNeverShadowed(row: EnvironmentProfile, r: Registration): bool = {
  val answer = connectedAnswer(row, r)
  match answer {
    | Shows(s) => connectUrls(r.connectReturn).length() == 0 and r.enabled and pageOffers(s.page) == NoAction
    | Refused(x) => not(retryableOf(x.refusal))
  }
}
```

### The pinned script forwards into the app link only the purpose's well-formed results, where the app reads them

The script reads the first value of each name from the fragment, then the
query, and checks its pattern: `state` `[A-Za-z0-9_-]{43}`, `connectionId`
`[A-Za-z0-9_-]{1,128}`, `session_id` `cs_(test|live)_[A-Za-z0-9]{1,200}`,
`result` `[a-z]{1,16}`. Sign-in forwards `error=app_link_unverified` with a
well-formed `state`, never a code; connect forwards `state`, `result` and,
only for `connected`, `connectionId`, all or nothing; billing forwards a
well-formed `session_id` and a `result` of `success` or `cancel`, which are
identifiers, not proof of payment. Sign-in and billing values go in the link's
query; connect values go in its fragment
(`intent://<host><path>#<values>#Intent;…;end`), because the app's connect
parser accepts only a fragment. The script then clears the query and fragment
from the address bar.

```quint
type ParamValue = MissingValue | MalformedValue | WellFormed({ text: str })
type ReturnParams = { stateParam: ParamValue, resultParam: ParamValue, connectionIdParam: ParamValue, sessionIdParam: ParamValue }
type Forwarded = { name: str, value: str }
type Carrier = InQuery | InFragment
pure def carrierOf(purpose: PagePurpose): Carrier = if (purpose == ConnectPage) InFragment else InQuery
pure val connectResults: List[str] = List("connected", "denied", "failed")
pure val billingResults: List[str] = List("success", "cancel")
pure def textOf(v: ParamValue): List[str] = match v { | WellFormed(w) => List(w.text) | _ => List() }
pure def named(name: str, v: ParamValue): List[Forwarded] = textOf(v).listMap(t => { name: name, value: t })
pure def connectForwarded(params: ReturnParams): List[Forwarded] = {
  val result = textOf(params.resultParam)
  val resultName = result.foldl("", (acc, t) => t)
  val idFits = if (resultName == "connected") textOf(params.connectionIdParam).length() == 1 else params.connectionIdParam == MissingValue
  if (textOf(params.stateParam).length() == 1 and result.length() == 1 and connectResults.includes(resultName) and idFits)
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
pure def lawOnlyAConnectionIsForwarded(purpose: PagePurpose, params: ReturnParams): bool =
  forwarded(purpose, params).some(f => f.name == "connectionId") implies purpose == ConnectPage
```

### Every page is private, unframed and unindexed, has no form, and runs at most the pinned script

Each answer carries `Cache-Control: no-store`, `X-Robots-Tag: noindex`,
`Referrer-Policy: no-referrer` and a CSP with `default-src 'none'`,
`form-action 'none'` and `frame-ancestors 'none'`. ReturnToApp's CSP
`script-src` names only the `sha256` of the one pinned script, which the build
computes; CheckoutOutcome has no `script-src`. The page's Bombadil properties
check that no element shows a query or fragment value and that the address
bar keeps neither.

```quint
type ScriptPolicy = NoScript | PinnedScript
type PageHeaders = { cacheControl: str, robots: str, referrerPolicy: str, frameAncestors: str, formAction: str, script: ScriptPolicy }
pure def scriptOf(page: Page): ScriptPolicy = if (pageIsReturnToApp(page)) PinnedScript else NoScript
pure def pageHeaders(page: Page): PageHeaders =
  { cacheControl: "no-store", robots: "noindex", referrerPolicy: "no-referrer", frameAncestors: "'none'", formAction: "'none'", script: scriptOf(page) }
```

## Story: Tell a payer the checkout ended

> As someone paying for another person's plan through a shared link, I want
> a page that tells me the checkout ended, so that I know to let them check
> their subscription in the app.

### The payer page shows the paid copy only for outcome=paid, the closed copy for anything else, reads nothing else and offers no action

`GET /api/v1/subscriptions/checkout/payer?outcome=` on the API origin is a
subscription route, so without the billing capability it answers
`404 capability_unavailable` (`deployment`). It reads no registry, session,
account, plan or payment state, and never claims a payment was made: the paid
copy asks the person to check the subscription in the app, which shows it
once the payment provider confirms it. The page names only the deployment's
display name.

```quint
pure val payerPath = "/api/v1/subscriptions/checkout/payer"
pure def isPayerUrl(row: EnvironmentProfile, url: ReturnUrl): bool = url.origin == row.api and url.path == payerPath
pure def payerOutcome(reported: str): PayerOutcome = if (reported == "paid") PaidOutcome else CanceledOutcome
pure def payerAnswer(row: EnvironmentProfile, reported: str): PageAnswer =
  if (routeOpen(row.capabilities, gateOf(SubscriptionRoutes))) Shows({ page: CheckoutOutcome({ shown: payerOutcome(reported), serviceName: row.name }) })
  else Refused({ refusal: capabilityRefusal })
pure val reportedValues = Set("paid", "canceled", "success")
pure def lawThePayerPageReadsOnlyTheOutcome(row: EnvironmentProfile, registry: List[Registration], readable: bool, served: Environment, reported: str): bool = {
  val url = { origin: row.api, path: payerPath }
  val answer = answerAt(row, readOf(registry, readable), served, url, reported)
  answer == answerAt(row, UnreadableRegistry, otherEnvironment(served), url, reported)
    and (answer == Shows({ page: CheckoutOutcome({ shown: PaidOutcome, serviceName: row.name }) }) iff (reported == "paid" and row.capabilities.contains(BillingCapability)))
}
```

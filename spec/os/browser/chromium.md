# Owned browser binding and staging

The owned Chromium browser a downstream app guides websites in: how the
device's resident runtime binds it, and how the build puts it, and the WebView
provider that replaces the image's stock one, into an image. The binding
decisions run in Java on Android's main thread
(`android/browser-surface/.../ChromiumBindingDemand.java`, from develop's
`plugins/plugin-native-browser-surface` and its `ChromiumBindingDemand.qnt`);
the binder calls, the package and certificate lookup and the timers stay in
`ChromiumBrowserConnection.java`. Staging is `src/browser/chromium.vibe`
(`stageBrowserApps`, `stageBrowserOverlay`, from develop's
`packages/os/scripts/android/stage-browser-apps.ts` and
`owned-browser-provenance.ts`): the shell parses manifests and descriptors,
reads each copied APK with `aapt` and `apksigner`, renders every module
presigned, preprocessed, without dex preopt and not privileged, and checks
the whole browser and vault pair before it replaces either. A downstream app
whose browser runs only in WebView surfaces does not use the binding.

## Story: Use the owned browser only with its expected identity

> As the device owner, I want my agent's browser bound, warmed and put into
> my image only as the package and signer I pinned, and kept bound only while
> something needs it, so that website tasks never drive an impostor browser
> and an idle phone keeps no browser service alive.

### A connection is used only after its package and signer are checked again, and a mismatch closes the binding for good

A bind is attempted only while something pins or holds the binding, and only
when the installed package and signing certificate match the build's
selected identity; otherwise the attempt reports `BindUntrusted`. A
connected callback checks package and certificate again: a match makes the
binding ready (warmup requested, never an activity, URL or debugging port),
a mismatch closes it, dropping every hold and waiting callback. A service
disconnect keeps Android's binding for its reconnect; a dead or null binding
is unbound.

```quint
type BindResult = BindAccepted | BindRefused | BindUntrusted | BindDenied
type Link = Unbound | RetryScheduled | Bound | Ready | Unavailable | Closed
type HoldId = int
type BrowserBinding = { link: Link, backoffMs: int, pinned: bool, nextHold: HoldId, openHolds: Set[HoldId], waiting: List[HoldId], fired: Set[HoldId], idlePending: bool }
type BindingStep = { state: BrowserBinding, out: List[HoldId] }
pure val firstRetryMs = 1000
pure val maxRetryMs = 30000
pure val initial: BrowserBinding = { link: Unbound, backoffMs: firstRetryMs, pinned: false, nextHold: 1, openHolds: Set(), waiting: List(), fired: Set(), idlePending: false }
pure def wanted(b: BrowserBinding): bool = b.pinned or b.openHolds.size() > 0
pure def holdsBinding(l: Link): bool = l == Bound or l == Ready
pure def live(l: Link): bool = holdsBinding(l) or l == RetryScheduled
pure def canConnected(b: BrowserBinding): bool = b.link == Bound
pure def connected(b: BrowserBinding, identityMatches: bool): BindingStep =
  if (identityMatches) { state: { ...b, link: Ready, backoffMs: firstRetryMs, waiting: List(), fired: b.fired.union(b.waiting.foldl(Set(), (ids, id) => ids.union(Set(id)))) }, out: b.waiting }
  else { state: close(b), out: List() }
pure def canDisconnected(b: BrowserBinding): bool = b.link == Ready
pure def disconnected(b: BrowserBinding): BrowserBinding = { ...b, link: Bound }
pure def canClose(b: BrowserBinding): bool = b.link != Closed
pure def close(b: BrowserBinding): BrowserBinding = { ...b, link: Closed, pinned: false, openHolds: Set(), waiting: List(), idlePending: false }
pure def alwaysClosedHoldsNothing(b: BrowserBinding): bool = b.link == Closed implies (b.openHolds.size() == 0 and b.waiting.length() == 0 and not(b.pinned) and not(b.idlePending))
pure def stepClosedStaysClosed(before: BrowserBinding, after: BrowserBinding): bool = before.link == Closed implies after.link == Closed
pure def sometimesClosedWithHoldsDropped(b: BrowserBinding): bool = b.link == Closed and b.nextHold > 1
```

### A refused bind is retried after a delay that doubles from one second to thirty

A refused bind, and a binding that died while wanted, schedule one retry
after `backoffMs` and double it, up to 30 seconds. A verified connection and
an idle release reset it to one second. A retry that fires when nothing
wants the binding binds nothing.

```quint
pure def nextBackoff(ms: int): int = if (ms * 2 > maxRetryMs) maxRetryMs else ms * 2
pure def bindWith(result: BindResult, b: BrowserBinding): BrowserBinding =
  if (holdsBinding(b.link) or not(wanted(b))) b
  else if (result == BindAccepted) { ...b, link: Bound }
  else if (result == BindRefused) { ...b, link: RetryScheduled, backoffMs: nextBackoff(b.backoffMs) }
  else { ...b, link: Unavailable }
pure def canRetryFires(b: BrowserBinding): bool = b.link == RetryScheduled
pure def retryFires(b: BrowserBinding, result: BindResult): BrowserBinding = bindWith(result, { ...b, link: Unbound })
pure def canLostBinding(b: BrowserBinding): bool = holdsBinding(b.link)
pure def lostBinding(b: BrowserBinding): BrowserBinding =
  if (wanted(b)) { ...b, link: RetryScheduled, backoffMs: nextBackoff(b.backoffMs) } else { ...b, link: Unbound }
pure def alwaysBackoffDoublesToThirtySeconds(b: BrowserBinding): bool = Set(1000, 2000, 4000, 8000, 16000, 30000).contains(b.backoffMs)
pure def sometimesRetryBackingOff(b: BrowserBinding): bool = b.link == RetryScheduled and b.backoffMs >= 4000
```

### A security denial or an untrusted package leaves no retry

Only a new pin or a new hold binds again after such an attempt; no timer
does, and the binding is not widened or launched another way.

```quint
pure def stepUnavailableWaitsForNewDemand(before: BrowserBinding, via: str, after: BrowserBinding): bool =
  (before.link == Unavailable and live(after.link)) implies (via == "pin" or via == "acquireHold")
pure def sometimesBrowserUnavailable(b: BrowserBinding): bool = b.link == Unavailable and wanted(b)
```

### Each ready callback fires at most once, only for an open hold that registered it

Each hold gets a fresh id and registers at most one ready callback. On a
ready binding it fires at once; otherwise it waits. The next verified
connection gives the shell the waiting callbacks in registration order.
Closing a hold drops its waiting callback. The shell checks that the
binding is still ready and the hold still open before it runs each
callback, since a preceding callback may close either.

```quint
pure val holdIdValues = Set(1, 2, 3)
pure def canAcquireHold(b: BrowserBinding): bool = b.link != Closed
pure def acquireHold(b: BrowserBinding, result: BindResult): BrowserBinding =
  bindWith(result, { ...b, nextHold: b.nextHold + 1, openHolds: b.openHolds.union(Set(b.nextHold)), idlePending: false })
pure def canRegisterReady(b: BrowserBinding, holdId: HoldId): bool = b.openHolds.contains(holdId) and not(b.waiting.includes(holdId)) and not(b.fired.contains(holdId))
pure def registerReady(b: BrowserBinding, holdId: HoldId): BindingStep =
  if (b.link == Ready) { state: { ...b, fired: b.fired.union(Set(holdId)) }, out: List(holdId) }
  else { state: { ...b, waiting: b.waiting.append(holdId) }, out: List() }
pure def canReleaseHold(b: BrowserBinding, holdId: HoldId): bool = b.openHolds.contains(holdId)
pure def releaseHold(b: BrowserBinding, holdId: HoldId): BrowserBinding = {
  val remaining = b.openHolds.exclude(Set(holdId))
  { ...b, openHolds: remaining, waiting: b.waiting.select(id => id != holdId), idlePending: not(b.pinned) and remaining.size() == 0 }
}
pure def alwaysCallbackCustody(b: BrowserBinding): bool =
  b.nextHold >= 1
    and b.waiting.every(id => b.openHolds.contains(id) and not(b.fired.contains(id)) and b.waiting.select(other => other == id).length() == 1)
    and b.openHolds.forall(id => id >= 1 and id < b.nextHold) and b.fired.forall(id => id >= 1 and id < b.nextHold)
pure def alwaysReadyHasNoWaiters(b: BrowserBinding): bool = b.link == Ready implies b.waiting.length() == 0
pure def stepReadyCallbackFiresOnce(before: BrowserBinding, via: str, after: BrowserBinding, out: List[HoldId]): bool =
  before.fired.subseteq(after.fired) and out.every(id => after.link == Ready and before.openHolds.contains(id) and not(before.fired.contains(id)) and after.fired.contains(id)
    and out.select(other => other == id).length() == 1 and (before.waiting.includes(id) or via == "registerReady"))
pure def sometimesWaitingCallbackFired(b: BrowserBinding): bool = b.link == Ready and b.fired.size() > 0 and b.openHolds.size() > 0 and not(b.pinned)
```

### A binding nobody pins or holds is released once idle

The resident service pins the binding while it runs. When the last hold
closes and nothing pins it, an idle release is scheduled; a new pin or hold
cancels it, and otherwise it unbinds and cancels any retry. A connection
reported after that release finds nothing bound and is ignored.

```quint
pure def canPin(b: BrowserBinding): bool = b.link != Closed
pure def pin(b: BrowserBinding, result: BindResult): BrowserBinding = bindWith(result, { ...b, pinned: true, idlePending: false })
pure def canUnpin(b: BrowserBinding): bool = b.pinned and b.link != Closed
pure def unpin(b: BrowserBinding): BrowserBinding = { ...b, pinned: false, idlePending: b.openHolds.size() == 0 }
pure def canIdleRelease(b: BrowserBinding): bool = b.idlePending
pure def idleRelease(b: BrowserBinding): BrowserBinding = { ...b, link: Unbound, backoffMs: firstRetryMs, idlePending: false }
pure def alwaysIdleReleaseOnlyWhenUnwanted(b: BrowserBinding): bool = b.idlePending implies (not(wanted(b)) and b.link != Closed)
pure def alwaysUnwantedLiveBindingIsReleasing(b: BrowserBinding): bool = (live(b.link) and not(wanted(b))) implies b.idlePending
pure def sometimesIdleReleased(b: BrowserBinding): bool = b.nextHold > 1 and b.link == Unbound and not(wanted(b)) and not(b.idlePending)
pure val fair_idleRelease = "weak"
pure def leadsToUnwantedBindingReleased(b: BrowserBinding, later: BrowserBinding): bool = (live(b.link) and not(wanted(b))) implies (not(live(later.link)) or wanted(later))
```

### An owned browser app enters an image only with its pinned digest, signer and provenance

The browser and the password vault app are each pinned by package, APK
SHA-256, a single signer and channel. An owned build also needs its
provenance to match. A development build needs the explicit development flag
on a debuggable image, and the flag is refused on a release image. An owned
build is admitted only as a development build until runtime qualification
exists, so a release image takes only stable upstream builds.

```quint
type ApkPin = { packageName: str, sha256: str, signer: str }
type ApkFacts = { packageName: str, sha256: str, signers: List[str], abisCovered: bool }
type Channel = Stable | Development
type ArtifactKind = UpstreamBuild | OwnedBuild
type ImageVariant = ReleaseImage | DebuggableImage
type AppPin = { pin: ApkPin, channel: Channel, kind: ArtifactKind }
type AppEvidence = { apk: ApkFacts, provenanceMatches: bool }
type ImageAdmission = { variant: ImageVariant, allowDevelopment: bool }
type AppRefusal = DevelopmentFlagOnRelease | DevelopmentBuildRefused | OwnedBuildUnqualified | ProvenanceMismatch | ApkMismatch
type AppVerdict = AppAdmitted | AppRefused({ why: AppRefusal })
pure val browserPin: ApkPin = { packageName: "browser", sha256: "d1", signer: "s1" }
pure val providerPin: ApkPin = { packageName: "provider", sha256: "d2", signer: "s2" }
pure def factsOf(pin: ApkPin): ApkFacts = { packageName: pin.packageName, sha256: pin.sha256, signers: List(pin.signer), abisCovered: true }
pure val wrongSigner: ApkFacts = { packageName: "browser", sha256: "d1", signers: List("s2"), abisCovered: true }
pure val appValues = Set({ pin: browserPin, channel: Stable, kind: UpstreamBuild }, { pin: browserPin, channel: Development, kind: OwnedBuild }, { pin: browserPin, channel: Stable, kind: OwnedBuild })
pure val evidenceValues = Set({ apk: factsOf(browserPin), provenanceMatches: true }, { apk: factsOf(browserPin), provenanceMatches: false }, { apk: wrongSigner, provenanceMatches: true })
pure val imageValues = Set({ variant: ReleaseImage, allowDevelopment: false }, { variant: ReleaseImage, allowDevelopment: true }, { variant: DebuggableImage, allowDevelopment: true }, { variant: DebuggableImage, allowDevelopment: false })
pure def matchesPin(apk: ApkFacts, pin: ApkPin): bool = apk.packageName == pin.packageName and apk.sha256 == pin.sha256 and apk.signers == List(pin.signer) and apk.abisCovered
pure def admitApp(app: AppPin, evidence: AppEvidence, image: ImageAdmission): AppVerdict =
  if (image.variant == ReleaseImage and image.allowDevelopment) AppRefused({ why: DevelopmentFlagOnRelease })
  else if (app.channel == Development and not(image.allowDevelopment)) AppRefused({ why: DevelopmentBuildRefused })
  else if (app.kind == OwnedBuild and app.channel == Stable) AppRefused({ why: OwnedBuildUnqualified })
  else if (app.kind == OwnedBuild and not(evidence.provenanceMatches)) AppRefused({ why: ProvenanceMismatch })
  else if (not(matchesPin(evidence.apk, app.pin))) AppRefused({ why: ApkMismatch })
  else AppAdmitted
pure def lawReleaseImageTakesOnlyStableUpstreamApps(app: AppPin, evidence: AppEvidence, image: ImageAdmission): bool =
  admitApp(app, evidence, image) == AppAdmitted implies (matchesPin(evidence.apk, app.pin) and (app.kind == OwnedBuild implies evidence.provenanceMatches) and (image.variant == ReleaseImage implies (app.channel == Stable and app.kind == UpstreamBuild)))
```

## Story: Replace the image's WebView provider only with the pinned one

> As a downstream app's builder, I want my browser, and if I pin one a WebView
> provider, staged into my image exactly as pinned, so that every app's
> WebView runs the provider I reviewed and nothing half-staged reaches a
> build.

### A staged overlay holds exactly the verified APK copies, and appears only through atomic publication

The descriptor names the vendor directory, module prefix and partition
(`namesValid`, parsed by the shell) and pins the browser and optionally a
WebView provider. A provider APK is supplied exactly when one is pinned.
Each APK is copied first and the copy is checked; the overlay folder is
written beside the output and published by one rename through core
[atomic publication](../../core/atomicPublication.md), so a failed or
crashed staging never reports success.

```quint
import atomicPublication as P from "../../core/atomicPublication"
type Partition = ProductPartition | SystemPartition
type WebViewChoice = StockWebView | PinnedWebView({ provider: ApkPin })
type OverlayDescriptor = { namesValid: bool, partition: Partition, browser: ApkPin, webview: WebViewChoice }
type SuppliedApk = NoApk | CopiedApk({ facts: ApkFacts })
type ModuleRole = BrowserModule | WebViewProviderModule
type PrebuiltModule = { role: ModuleRole, packageName: str, sha256: str, signer: str, overrides: List[str], requires: List[str] }
type BrowserOverlay = { partition: Partition, modules: List[PrebuiltModule], webviewProviders: List[str] }
type OverlayRefusal = InvalidDescriptor | ProviderIsTheBrowser | ProviderApkNotPaired | BrowserApkMismatch | ProviderApkMismatch | NotPublished
type OverlayOutcome = OverlayStaged({ overlay: BrowserOverlay }) | OverlayRefused({ reason: OverlayRefusal }) | OverlayUnknown
pure val dValues = Set({ namesValid: true, partition: ProductPartition, browser: browserPin, webview: StockWebView }, { namesValid: true, partition: SystemPartition, browser: browserPin, webview: PinnedWebView({ provider: providerPin }) },
  { namesValid: true, partition: ProductPartition, browser: browserPin, webview: PinnedWebView({ provider: browserPin }) }, { namesValid: false, partition: ProductPartition, browser: browserPin, webview: StockWebView })
pure val browserApkValues = Set(factsOf(browserPin), wrongSigner)
pure val webviewApkValues = Set(NoApk, CopiedApk({ facts: factsOf(providerPin) }), CopiedApk({ facts: factsOf(browserPin) }))
pure val stockWebViewModule = "webview"
pure val webViewLibraries = List("libwebviewchromium_loader", "libwebviewchromium_plat_support")
pure def prebuilt(role: ModuleRole, pin: ApkPin, overrides: List[str], requires: List[str]): PrebuiltModule = { role: role, packageName: pin.packageName, sha256: pin.sha256, signer: pin.signer, overrides: overrides, requires: requires }
pure def renderOverlay(d: OverlayDescriptor): BrowserOverlay = {
  val choice = d.webview
  val browserModule = prebuilt(BrowserModule, d.browser, List(), List())
  match choice {
    | StockWebView => { partition: d.partition, modules: List(browserModule), webviewProviders: List() }
    | PinnedWebView(w) => { partition: d.partition, modules: List(browserModule, prebuilt(WebViewProviderModule, w.provider, List(stockWebViewModule), webViewLibraries)), webviewProviders: List(w.provider.packageName) }
  }
}
pure def providerFaults(w: WebViewChoice, apk: SuppliedApk, browser: ApkPin): List[OverlayRefusal] = match w {
  | StockWebView => match apk { | NoApk => List() | _ => List(ProviderApkNotPaired) }
  | PinnedWebView(p) => if (p.provider.packageName == browser.packageName) List(ProviderIsTheBrowser) else match apk { | NoApk => List(ProviderApkNotPaired) | CopiedApk(c) => if (matchesPin(c.facts, p.provider)) List() else List(ProviderApkMismatch) }
}
pure def overlayFaults(d: OverlayDescriptor, browserApk: ApkFacts, webviewApk: SuppliedApk): List[OverlayRefusal] =
  (if (d.namesValid) List() else List(InvalidDescriptor)).concat(providerFaults(d.webview, webviewApk, d.browser)).concat(if (matchesPin(browserApk, d.browser)) List() else List(BrowserApkMismatch))
pure def stageOverlay(d: OverlayDescriptor, browserApk: ApkFacts, webviewApk: SuppliedApk, receipt: P::PublicationReceipt): OverlayOutcome = {
  val faults = overlayFaults(d, browserApk, webviewApk)
  if (faults.length() > 0) OverlayRefused({ reason: faults.nthOr(0, InvalidDescriptor) })
  else if (receipt == P::SuccessReceipt) OverlayStaged({ overlay: renderOverlay(d) })
  else if (receipt == P::UnknownReceipt) OverlayUnknown
  else OverlayRefused({ reason: NotPublished })
}
pure def isCopy(m: PrebuiltModule, apk: ApkFacts): bool = m.packageName == apk.packageName and m.sha256 == apk.sha256 and apk.signers == List(m.signer)
pure def isSuppliedCopy(m: PrebuiltModule, apk: SuppliedApk): bool = match apk { | NoApk => false | CopiedApk(c) => isCopy(m, c.facts) }
pure def lawStagedOverlayIsTheVerifiedCopies(d: OverlayDescriptor, browserApk: ApkFacts, webviewApk: SuppliedApk, receipt: P::PublicationReceipt): bool = {
  val staging = stageOverlay(d, browserApk, webviewApk, receipt)
  match staging {
    | OverlayStaged(s) => receipt == P::SuccessReceipt and d.namesValid and s.overlay.modules.every(m => if (m.role == BrowserModule) isCopy(m, browserApk) else isSuppliedCopy(m, webviewApk))
    | _ => true
  }
}
```

### The framework lists only the pinned provider, another package that overrides the stock WebView and carries its libraries

Without a pinned provider the stock WebView and its framework list stay as
they are.

```quint
pure def lawOnlyThePinnedProviderServesWebView(d: OverlayDescriptor, browserApk: ApkFacts, webviewApk: SuppliedApk, receipt: P::PublicationReceipt): bool = {
  val staging = stageOverlay(d, browserApk, webviewApk, receipt)
  match staging {
    | OverlayStaged(s) => s.overlay.webviewProviders.length() <= 1 and (s.overlay.webviewProviders.length() == 0 iff d.webview == StockWebView)
        and s.overlay.webviewProviders.every(pkg => pkg != d.browser.packageName)
        and s.overlay.modules.every(m => m.role == WebViewProviderModule implies (s.overlay.webviewProviders == List(m.packageName) and m.overrides == List(stockWebViewModule) and m.requires == webViewLibraries))
    | _ => true
  }
}
```

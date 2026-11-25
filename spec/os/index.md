# Android device

The os package is everything Android-native that Eliza ships to a device:
the agent service that runs the owner's agent, the device half of sign-in
and credential custody, the native bridges, the wake listener, the system
and app updaters, the first-run provisioner and the image overlays. It also
holds the library that builds the device image and the Android host APK, and
the browser with its owned Chromium build and the app-update trust slice. A
consumer owns its product: the os package names none, and takes the
consumer's descriptor over one pinned device profile.

The [device execution journal](../agent/deviceActions/execution.md) and
[reviewed operation values](../agent/deviceActions/operations.md) are Agent
client contracts; native executors live here.

A consumer owns its own interface (its mobile shell, view primitives and
screen focus handling). It owns its own Android test harness beyond the
single-device lease, instrumentation result, isolated test user and fixture
observation and reboot of `image/device`, such as hosted fixtures for a CI
emulator display and WebView provisioning. It owns its own desktop builds,
with their library staging and symbol checks. The os package specifies none
of them.

| Area | Specifications |
| --- | --- |
| Agent service | [Agent channel](./agentService/channel.md), [agent health verdicts](./agentService/health.md), [service lifecycle](./agentService/lifecycle.md), [agent data files](./agentService/config.md), [on-device inference host](./agentService/inference.md) |
| Sign-in | [Device credential](./signIn/credential.md), [sign-in readiness](./signIn/readiness.md), [sign-in flow](./signIn/flow.md), [browser sign-in return](./signIn/browserReturn.md), [cloud requests](./signIn/cloudRequests.md) |
| Android bridges | [Bridge vocabulary](./android/bridge.md), [system surfaces](./android/system.md), [home launcher](./android/home.md), [links and alerts](./android/deepLinks.md), [secure store](./android/secureStore.md), [device calendar](./android/calendar.md), [deletion window](./android/deletionWindow.md), [deferred deletion](./android/deferredDeletion.md), [contacts](./android/contacts.md), [keyset paging](./android/paging.md), [camera](./android/camera.md), [phone](./android/phone.md), [visual voicemail](./android/voicemail.md), [notification mirror](./android/notificationMirror.md), [text messages](./android/messages.md), [agent notice projection](./android/notificationProjection.md), [task keys](./android/taskKeys.md), [reminder alarms](./android/reminderAlarms.md), [notice routes](./android/noticeRoutes.md), [Wi-Fi](./android/wifi.md), [network cost](./android/networkPolicy.md), [app data reset](./android/reset.md) |
| Files | [Storage and trash custody](./android/files/storage.md), [storage watch](./android/files/storageWatch.md), [read-only handoff](./android/files/handoff.md), [document grants](./android/files/documentGrants.md) |
| Media | [Tokens and row writes](./android/media/rows.md), [photos catalog](./android/media/catalog.md), [media review](./android/media/review.md), [owned trash](./android/media/trash.md), [albums](./android/media/albums.md), [edit copies](./android/media/editCopy.md), [photo replacement](./android/media/photoReplace.md), [video playback](./android/media/videoPlayback.md), [isolated PDF](./android/media/isolatedPdf.md) |
| Passwords | [Vault page](./android/passwords/vault.md), [autofill](./android/passwords/autofill.md) |
| Browser | [Address](./browser/address.md), [surface lifecycle](./browser/surface/lifecycle.md), [surface profiles](./browser/surface/profiles.md), [tab storage](./browser/tabHost/storage.md), [page reading](./browser/tabHost/reading.md), [page commands](./browser/pageCommands.md), [owned Chromium](./browser/chromium.md), [protection](./browser/protection.md), [tab document custody](./browser/tabHost/document.md), [surface page requests](./browser/surface/pageRequests.md), [surface commands](./browser/surface/commands.md), [dock](./browser/surface/dock.md) |
| Image | [Source lock](./image/sourceLock.md), [APK admission](./image/apk.md), [launcher staging](./image/staging.md), [listener staging](./image/listener.md), [image provisioning](./image/provisioning.md), [first run](./image/firstRun.md), [product composition](./image/product.md), [device qualification](./image/qualification.md), [booted-image verification](./image/verification.md), [release signing](./image/signing.md), [device test harness](./image/harness.md) |
| Android host build | [Android host profile](./build/androidHost.md), [Source integrity](./build/sourceIntegrity.md), [runtime payload](./build/runtimePayload.md), [Android build and APK publication](./build/androidBuild.md) |
| Updates | [System updater](./update/updater.md), [operator update by cable](./update/operator.md) |
| App updates | [Trust and publication authorization](./appUpdate/admission.md), [installation journal](./appUpdate/install.md), [update health](./appUpdate/health.md), [update policy](./appUpdate/policy.md) |
| Voice | [Listening indicator lease](./voice/indicatorLease.md), [invocation](./voice/invocation.md), [microphone](./voice/microphone.md), [speech output](./voice/speechOutput.md), [wake listener](./voice/listener.md), [cloud speech](./voice/cloudSpeech.md), [live capture](./voice/liveCapture.md) |

## Story: Sign in with a saved password in the private browser

> As the person, I want to use Android's password picker on the exact
> website I am visiting, so I can sign in without giving the assistant
> my password or my signed-in browser session.

### Protected sign-in opens in a new temporary browser profile

The host offers a public HTTPS sign-in destination in its local interface.
The browser opens a private visit only when Android has a renderer outside
the app, isolated storage and a WebView that can attest the frame origin.
The host opens a fresh temporary profile and retires it on close.
The assistant can describe the public destination. The visit reports the
HTTPS origin and basic presentation and load state to the local interface.
Page content, title, address path, query, download data and authenticated
browser state stay outside the host bridge and outside assistant tools. The host protects the window during the
private visit. All browser-surface capture requests are refused while the
protected visit exists, and opening it invalidates any capture in progress.

```quint
type SignInAudience = LocalInterface | Assistant
type SignInObservation = PublicDestination | SurfaceMetadata | PageArtifact | Credential | AuthenticatedSession
pure def mayObserveSignIn(audience: SignInAudience, observation: SignInObservation): bool =
  observation == PublicDestination or (audience == LocalInterface and observation == SurfaceMetadata)
pure def lawAssistantSeesOnlyPublicDestination(observation: SignInObservation): bool =
  mayObserveSignIn(Assistant, observation) == (observation == PublicDestination)
type SignInVisit = {
  open: bool, shown: bool, resumed: bool, committed: bool, bound: bool,
  chosen: bool, filled: bool, capture: bool
}
pure val initial: SignInVisit = {
  open: false, shown: false, resumed: true, committed: false,
  bound: false, chosen: false, filled: false, capture: false
}
pure def canOpenSignIn(s: SignInVisit, isolatedProcess: bool, freshStorage: bool, nativeFrameOrigin: bool): bool =
  not(s.open) and isolatedProcess and freshStorage and nativeFrameOrigin
pure def openSignIn(s: SignInVisit, isolatedProcess: bool, freshStorage: bool, nativeFrameOrigin: bool): SignInVisit =
  { ...initial, open: true, resumed: s.resumed }
pure def canCloseSignIn(s: SignInVisit): bool = s.open
pure def closeSignIn(s: SignInVisit): SignInVisit = { ...initial, resumed: s.resumed }
pure def canStartCapture(s: SignInVisit): bool = not(s.open or s.capture)
pure def startCapture(s: SignInVisit): SignInVisit = { ...s, capture: true }
pure def canReleaseCapture(s: SignInVisit): bool = s.capture and not(s.open)
pure def releaseCapture(s: SignInVisit): SignInVisit = { ...s, capture: false }
pure def alwaysVisitBlocksCapture(s: SignInVisit): bool = s.open implies not(s.capture)
pure def stepOpeningRevokesCapture(before: SignInVisit, via: str, after: SignInVisit): bool =
  via == "openSignIn" implies after.open and not(after.capture)
```

### Only the person can fill an exact field in the current website

The selected, visible, resumed surface needs a committed HTTPS document.
Its engine-reported frame origin must match that document's precise origin,
including its port. The browser uses the native Autofill binding. The
password provider opens a fresh native unlock and the person chooses an
entry. The device fills only the bound field, and there is no application
bridge operation to fetch or fill a credential. Navigating, hiding, or
closing the visit invalidates the pending choice. The provider may cancel
or expire it. The activity pause while
Android shows its own picker keeps the pending choice, but delivering it
waits for the still-current foreground document.

```quint
pure def canShowSignIn(s: SignInVisit): bool = s.open and not(s.shown)
pure def showSignIn(s: SignInVisit): SignInVisit = { ...s, shown: true }
pure def canHideSignIn(s: SignInVisit): bool = s.shown
pure def hideSignIn(s: SignInVisit): SignInVisit =
  { ...s, shown: false, bound: false, chosen: false, filled: false }
pure def canCommitSignIn(s: SignInVisit, committedHttps: bool): bool = s.open and committedHttps
pure def commitSignIn(s: SignInVisit, committedHttps: bool): SignInVisit =
  { ...s, committed: true, bound: false, chosen: false, filled: false }
pure def canNavigateSignIn(s: SignInVisit): bool = s.open and s.committed
pure def navigateSignIn(s: SignInVisit): SignInVisit =
  { ...s, committed: false, bound: false, chosen: false, filled: false }
pure def canPauseHost(s: SignInVisit): bool = s.resumed
pure def pauseHost(s: SignInVisit): SignInVisit = { ...s, resumed: false, filled: false }
pure def canResumeHost(s: SignInVisit): bool = not(s.resumed)
pure def resumeHost(s: SignInVisit): SignInVisit = { ...s, resumed: true }
pure def canBindSignInField(s: SignInVisit, exactEngineOrigin: bool): bool =
  s.open and s.shown and s.resumed and s.committed and exactEngineOrigin
pure def bindSignInField(s: SignInVisit, exactEngineOrigin: bool): SignInVisit =
  { ...s, bound: true, chosen: false, filled: false }
pure def canChoosePassword(s: SignInVisit, freshNativeUnlock: bool): bool =
  s.bound and freshNativeUnlock and not(s.chosen)
pure def choosePassword(s: SignInVisit, freshNativeUnlock: bool): SignInVisit =
  { ...s, chosen: true, filled: false }
pure def canCancelPasswordChoice(s: SignInVisit): bool = s.bound
pure def cancelPasswordChoice(s: SignInVisit): SignInVisit =
  { ...s, bound: false, chosen: false, filled: false }
pure def canFillPassword(s: SignInVisit): bool = s.bound and s.chosen and s.resumed
pure def fillPassword(s: SignInVisit): SignInVisit = { ...s, filled: true, chosen: false }
pure def alwaysShownSignInIsOpen(s: SignInVisit): bool = s.shown implies s.open
pure def alwaysBoundFieldIsCurrent(s: SignInVisit): bool = s.bound implies s.shown and s.committed
pure def alwaysChoiceHasField(s: SignInVisit): bool = s.chosen implies s.bound
pure def alwaysFillStaysForeground(s: SignInVisit): bool = s.filled implies s.bound and s.resumed
pure def stepFillConsumesNativeChoice(before: SignInVisit, via: str, after: SignInVisit): bool =
  via == "fillPassword" implies before.chosen and after.filled and not(after.chosen)
pure def sometimesPersonFillsPassword(s: SignInVisit): bool = s.filled
```

## Story: Keep building my product against the paths and names I import

> As a consumer, I want every os package file I reach by path, and every
> name I read from its build and image entries, to stay where I import it,
> so that advancing my pin never breaks my build before this package's own
> checks have said so.

### Every promised path and name is still published

The os package promises a consumer the files and directories below, by
path from the package root, the named exports of the modules it loads by
path, and the named exports of `@elizaos/os`.
Each stays published. Taking one away starts by removing it from this
list, which is reviewed as any rule is.

```quint
pure val consumerPaths = List(
  "android/browser-surface/src/main/java/ai/eliza/plugins/browsersurface/ChromiumBrowserIdentity.java",
  "android/build-consumer.mjs", "android/toolchain.ts", "android/host-templates",
  "android/local-inference/consumer.gradle", "android/local-inference/engine.lock.json", "android/local-inference/inputs.json",
  "android/local-inference/scripts/build-helpers/arm64-simd.ts", "android/local-inference/scripts/build-helpers/elizavoice-build-flags.ts",
  "android/local-inference/scripts/build-helpers/verify-fused-symbols.ts", "android/local-inference/scripts/build-native.ts",
  "android/local-inference/scripts/build-phonon2-gguf.ts", "android/local-inference/scripts/engine.ts",
  "android/local-inference/scripts/stage-elizavoice-lib.ts", "android/local-inference/src/main/elizavoice-jni/CMakeLists.txt",
  "android/local-inference/src/main/elizavoice-jni/elizavoice-jni.cpp", "android/local-inference/src/main/java/ai/eliza/voice/VoiceNative.java",
  "android/local-inference/voice-model-versions.json", "android/media/src/main/java/ai/eliza/plugins/media", "android/sense",
  "android/sign-in/build.gradle",
  "aosp/aosp.lock.json", "aosp/devices/pixel10a", "aosp/launcher-provisioning.mjs",
  "aosp/patches/soong-app-native/manifest.json", "aosp/runtime/node.lock.json", "aosp/sense/config.xml",
  "aosp/sense/systemui/chip", "aosp/soong-app-native.mjs", "aosp/sources/pixel10a-stallion.json",
  "aosp/sources/secure-camera.json", "aosp/stage-launcher-overlay.ts", "aosp/system-updater",
  "src/build/android-host.vibe", "src/build/runtime-payload.vibe", "src/cli.vibe")
pure val consumerPathNames = List(
  "android/build-consumer.mjs#buildAndroidConsumer",
  "android/local-inference/scripts/build-helpers/verify-fused-symbols.ts#assertAndroidVoiceLibrary",
  "android/local-inference/scripts/build-helpers/verify-fused-symbols.ts#minElfLoadAlignment",
  "android/toolchain.ts#resolveAndroidSdkRoot", "android/toolchain.ts#resolveJavaHome", "android/toolchain.ts#javaMajorVersion",
  "aosp/launcher-provisioning.mjs#manifestComponents", "aosp/launcher-provisioning.mjs#provisioningComponents",
  "aosp/launcher-provisioning.mjs#renderProvisioningOverlay", "aosp/soong-app-native.mjs#soongAppNativePatch",
  "aosp/stage-launcher-overlay.ts#REVIEWED_PRIVILEGED_PERMISSIONS", "aosp/stage-launcher-overlay.ts#launcherInstallDirectory",
  "aosp/stage-launcher-overlay.ts#main", "aosp/stage-launcher-overlay.ts#renderOverlay",
  "aosp/stage-launcher-overlay.ts#validateDescriptor")
pure val consumerBuildNames = List("buildAndroid", "exportCommittedSources", "generateAndroidHost", "stageRuntimePayload", "verifyCommittedWorkspace")
pure val consumerImageNames = List(
  "NATIVE_INSTALLS", "NATIVE_TARGETS", "aaptManifestTree", "acquireDeviceLease", "admitImageApk", "apkReleaseBlockers",
  "apkUpdateAdmission", "assertStockVendorApi", "cloudVoiceAdmission", "compareDomains", "javaMajorVersion",
  "listAndroidArtifactEntries", "loadProfile", "manifestFacts", "otaMain", "parseXmlTree", "prepareListenerSystemui",
  "provisioningComponents", "readAndroidArtifactEntryBuffers", "readApkBuildFlags", "readApkSignerDigest", "readNativeLibraries",
  "readbackInventory", "releaseDescriptorProblems", "releaseRecordProblems", "requireClockProduct",
  "requireInstrumentationSuccess", "resolveAndroidSdkRoot", "resolveJavaHome", "runIsolatedAndroidTest", "signRelease",
  "stageLauncher", "verifyDeviceSource", "verifyImage", "verifyListenerSystemui", "verifySecureCameraSource", "verifySource",
  "writeImageCapability", "writeSecureCameraOverlay")
pure def withdrawnFromConsumers(published: List[str], promised: List[str]): List[str] =
  promised.select(x => not(published.includes(x)))
```

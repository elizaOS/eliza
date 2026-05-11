# Milady Mobile (iOS + Android) — Scathing Audit & Build-Tier Implementation Plan

**Date:** 2026-05-11
**Scope:** Run the entire Milady (elizaOS) application on mobile, local-first, across three distribution tiers — App Store, Xcode developer install, sideload.
**Verdict (tl;dr):** The plumbing is much further along than I expected. The strategy is wrong. The iOS team capitulated to a "cloud agent" architecture under a misreading of Apple's JIT rules. The on-device agent is buildable today on iOS, in the WebView's JIT-enabled JavaScriptCore, with the existing PGlite + LlamaCppCapacitor stack — and the work to get there is mostly deletion and rewiring, not new code.

---

## 1. The Central Wrong Decision

`SETUP_IOS.md` opens:

> The iOS app is a **cloud-hybrid** Capacitor build: Apple forbids running a JIT-enabled JavaScript runtime (bun, JavaScriptCore at runtime, etc.) inside an App Store-shipped app, so there is no on-device bun process.

The first half is correct, the second half is wrong, and the conclusion is a non-sequitur.

**What Apple actually forbids:** an app embedding *its own* JIT-capable interpreter. That kills bun, Node+V8, and any third-party JIT.

**What Apple permits:** running JS inside **WKWebView**, which uses the system JavaScriptCore *with* JIT (Apple grants WKWebView a hardened-runtime exception via the dynamic-codesigning entitlement). Your Capacitor app already ships JS that runs at full JIT speed inside the WebView. There is nothing stopping the entire agent runtime from running there. The "no on-device bun process" conclusion only forbids a separate executable — not the agent itself.

The Android architecture was built around a Bun subprocess because Android *allows* arbitrary executables in app-private storage. Someone copied that mental model to iOS, hit Apple's executable ban, and concluded "no on-device agent on iOS." That conclusion is wrong by one architectural layer: on iOS the agent runs **in the WebView**, not in a separate executable.

**Consequence of this misread:** the iOS app has been engineered as a thin shell around a cloud endpoint, and the only "local" thing about it is the LLM weights. Trajectory, memory, planner loop, tool calls, scheduler — all cloud. That is not what is wanted, and it is not what the user is paying for when they want a local-first product.

---

## 2. State of the World (Validated, Not Hearsay)

### 2.1 iOS — what exists today

- `eliza/packages/app-core/platforms/ios/` — full Capacitor template directory. Regenerated into `apps/app/ios/` on every build via `run-mobile-build.mjs ios-overlay`. Gitignored output.
- `App.xcodeproj` + `App.xcworkspace`, `AppDelegate.swift` (UIKit lifecycle, APNs gated on `ELIZA_APNS_ENABLED`), `SceneDelegate.swift`, `ElizaIntentPlugin.swift` (App Intents bridge).
- `WebsiteBlockerContentExtension/ActionRequestHandler.swift` — Safari Content Blocker extension; reads rules from App Group `group.com.miladyai.milady`.
- `Podfile` (verified): pulls `Capacitor`, `CapacitorApp`, `CapacitorBarcodeScanner`, `CapacitorBrowser`, `CapacitorHaptics`, `CapacitorKeyboard`, `CapacitorPreferences`, `CapacitorPushNotifications`, `LlamaCppCapacitor` 0.1.5, plus 12 `@elizaos/capacitor-*` plugins (Agent, Camera, Calendar, Canvas, Gateway, Location, MobileSignals, Screencapture, Swabble, Talkmode, Websiteblocker).
- `fastlane/` — `certs`, `build`, `beta` (TestFlight), `release` (App Store), `metadata` lanes wired against `MATCH_GIT_URL`, App Store Connect API key envs. App Store export marked encryption-exempt, no IDFA.
- `Info.plist` and `App.entitlements` are merged at build time by `overlayIos()` in `run-mobile-build.mjs`; Universal Link entitlement slot and `CFBundleURLTypes` slot both exist but **OAuth callback is not wired** (SETUP_IOS.md open item).
- `PrivacyInfo.xcprivacy` exists (required by Apple since iOS 17).
- 14 Swift Capacitor plugins under `eliza/packages/native-plugins/*/ios/Sources/`. The heavy ones: `camera` (48 KB), `canvas` (72 KB), `mobile-signals` (48 KB), `screencapture` (28 KB), `swabble` (52 KB), `talkmode` (40 KB), `agent` (36 KB).
- `LlamaCppCapacitor` Pod is installed via npm-resolved path; comes from `node_modules/llama-cpp-capacitor` (workspace at present).

### 2.2 iOS — what is broken or missing today

- **No on-device agent runtime.** Despite all of the above, no Swift code boots the agent, and no JS path on the WebView side initializes it either. The flow is: WebView loads UI → UI calls Eliza Cloud HTTP endpoint. The local agent that runs on Android in `ElizaAgentService` has no iOS analog.
- **No model file ships in the app bundle.** Per SETUP_IOS.md: ODR (On-Demand Resources) for GGUF assets is a TODO. There is a documented script `scripts/miladyos/stage-models-odr.mjs` that does not exist.
- **`LlamaCppCapacitor.swift` does not call `NSBundleResourceRequest`** — so even if you ODR-staged a model, the Swift side can't find it.
- **OAuth callback not wired.** Universal Link + `CFBundleURLTypes` slots exist; the actual dispatch in `AppDelegate.application(_:open:options:)` only forwards to `ApplicationDelegateProxy.shared` — no Anthropic/Codex/Cloud handler.
- **App Intents (`ElizaIntentPlugin.swift`, 11 KB)** were "newly added, framework scope TBD" per the audit. Effectively dead.
- **Bundle ID + app group strings are rewritten at build time** to `com.miladyai.milady`/`group.com.miladyai.milady`. Fine, but it means git diffing the generated project is meaningless and every developer needs the same overlay step to reproduce.
- **`pod install` has never been verified on Mac** per the open-items list in SETUP_IOS.md. The Linux side of the build is exercised by CI; the macOS-side actually-build-an-IPA path is unverified.
- **Foreground audio (Talk Mode)** — `TalkModePlugin` exists but `AVAudioSession` background mode entitlement and `UIBackgroundModes` (`audio`) are not enabled in the template's `Info.plist`. Without that, the talk-mode pipeline dies the moment the app backgrounds.
- **No `BGTaskScheduler` integration.** The agent's autonomy/training/trajectory rotation has no iOS background path. Android uses WorkManager (15-min floor, Doze-deferred). iOS gives you `BGAppRefreshTask` (~30s of execution, opportunistic, no guaranteed cadence) and `BGProcessingTask` (longer, but only when charging + Wi-Fi). Neither is wired.
- **Push notifications** are gated by `ELIZA_APNS_ENABLED=1` Info.plist flag; APNs delivery wakes the app but the agent-side cloud-fanout endpoint is unimplemented. So you can't even use push to wake the agent for inference.
- **Web inspector / safari devtools** for the WebView are presumably off in release; no documented enable-in-debug helper.
- **`ElizaIntentPlugin.swift`** has no AppShortcuts provider, no static-vocabulary phrases, no `AppIntent` conformance verified. Siri integration is theoretical.
- **WKWebView storage cap** — the WebView's IndexedDB is subject to Apple's eviction rules. PGlite uses IDB internally for storage; under storage pressure the agent's database disappears silently. There is no documented mitigation.
- **No simulator-tested model path.** The "smallest possible working model" question — what GGUF can we load in the iPhone simulator on an M-series Mac, do we ship it, do we download it? — is unanswered.

### 2.3 Android — what exists today

This is the more honest one. The Android stack is much further along.

- `eliza/packages/app-core/platforms/android/` — full Gradle project. AGP 9.2.0, Kotlin 2.3.21, Java 21, compileSdk 34, minSdk 24, namespace `app.eliza`. ProGuard minification on, signing via env (`ELIZAOS_KEYSTORE_PATH`/`KEY_ALIAS`/`KEY_PASSWORD`/`VERSION_CODE`/`VERSION_NAME`).
- 19 Java sources under `ai.elizaos.app.*`. The interesting ones:
  - `ElizaAgentService.java` — foreground service. Unpacks bundled Bun + agent JS payload from `assets/agent/` into app-private storage, spawns it on `127.0.0.1:31337` with a per-boot bearer token, enables mixed-content loopback fetches from the WebView.
  - `GatewayConnectionService.java` — separate foreground service that holds the process alive when WebView is backgrounded.
  - `ElizaBootReceiver.java` — `BOOT_COMPLETED` receiver, restarts the gateway service. Uses reflection to grant `GET_USAGE_STATS` appop on AOSP builds.
  - `MainActivity.java` — Capacitor host, starts both services on launch.
  - System-level activities (`ElizaDialActivity`, `ElizaSmsReceiver`, `ElizaInCallService`, `ElizaAssistActivity`, etc.) — only active in AOSP privileged builds; inert in Capacitor builds.
- **Three Android build profiles** (per `SETUP_AOSP.md` and `run-mobile-build.mjs`):
  - `build:android:cloud` — Play Store thin client. No on-device runtime. ~150 MB APK.
  - `build:android` — sideload debug. Full on-device agent. Bun bundled. Play Store would reject (dynamic code).
  - `build:android:system` — AOSP privileged. Platform-signed. Placed at `/system/priv-app/<Brand>/`. ~250 MB.
- llama-cpp-capacitor JNI bridge for in-WebView LLM inference on the Play Store thin client.
- 17 native plugin Android modules.
- `WorkManager` for background tasks via `plugin-background-runner`. 15-minute floor, Doze-deferred.
- GitHub Actions: `android-apk.yml` (debug APK artifact), `android-release.yml` (Play release).
- `fastlane/` with Android Fastfile.

### 2.4 Android — gaps and lies

- The Play Store APK that ships today does **not** run a local agent. Despite all the JNI/Capacitor infrastructure, the Play Store path is also cloud-hybrid by default. Local Llama is opt-in.
- AOSP build is the only Android variant that runs a real on-device agent, and it requires a privileged-app slot — which is a brand-of-Android distribution model, not a consumer-installable product.
- Sideload APK is functional but Play-rejected. There is no documented user-facing distribution channel for it.
- `plugin-background-runner` is documented but the actual auto-training / trajectory-rotation cadence rides on top of HTTP polling against `/api/background/run-due-tasks` — there is no actual cron under the runtime. If the agent process is dead, the WorkManager job has nothing to call.

### 2.5 Frontend (`apps/app`)

- Vite + React 19. Capacitor 8 plugins imported, runtime-detects WebView vs Electrobun via `isElectrobunRuntime()` and `normalizeMobileRuntimeMode()`. Bundle ID `com.miladyai.milady` / app name `Milady`.
- Desktop-isms (`-webkit-app-region`, native tray, drag region) are isolated behind Electrobun runtime checks. Mobile build does not pull them.
- `@elizaos/capacitor-*` packages give the React side typed access to camera, location, contacts, calendar, talk-mode, screen capture, etc.
- `Three.js` avatar pipeline — flagged in `CLAUDE.md` as bundle-sensitive. No mobile fallback for low-end GPU.
- `localStorage` + `@capacitor/preferences` for token storage. No KeyChain/Keystore-backed secret storage — secrets in localStorage on iOS are not encrypted, only sandboxed.

### 2.6 Local inference / model serving

- Desktop reality: `dflash-server.ts` spawns a custom-forked `llama-server` subprocess; voice goes through `bun:ffi` to `libelizainference.dylib`. Custom kernels (DFlash speculative decode, TurboQuant, QJL, polarquant) — not portable.
- Mobile reality: `llama-cpp-capacitor` is a Capacitor plugin wrapping stock llama.cpp (Android: jniLibs, iOS: framework). DFlash is unavailable; voice TTS via OmniVoice is unavailable; ASR via fused omnivoice is unavailable.
- `capacitor-llama-adapter.ts` exists and bridges the agent's `LocalInferenceLoader` contract onto the plugin. This is the right design.
- `kv-cache-resolver.ts` does prefix-cache routing on cacheKey. Mobile uses a 4-slot parallel pool.
- Embeddings: feature-detected on the plugin (`embedding?:` optional method) — older builds (≤0.1.4) throw. There's no fallback embedder ("just don't ship local embeddings on those builds"). This will silently break vector-memory recall on older devices.

### 2.7 Runtime portability (the real porting cost)

What the desktop runtime imports that breaks in a WebView context:
- `process.env.NODE_PATH` + `Module._initPaths()` in `agent/runtime/eliza.ts` — fatal in any non-Node runtime.
- `createRequire`, `fileURLToPath`, `pathToFileURL` everywhere.
- `os.homedir()` in `core/src/index.node.ts` for state-dir resolution.
- `node:crypto` in `core/src/features/secrets/crypto/encryption.ts` — must port to Web Crypto.
- `fs` everywhere — trajectory recorder, TODO service, plugin resolver.
- `node:stream` in voice transcriber.
- Native modules: `sharp`, `canvas`, `onnxruntime-node`, `node-llama-cpp`, `pg`.

What the mobile build *already* mitigates:
- `eliza/packages/agent/scripts/build-mobile-bundle.mjs` produces a Bun-built static bundle for the mobile agent payload, with `eliza/packages/agent/scripts/mobile-stubs/*.cjs` providing throw-on-call stubs for: `argon2`, `canvas`, `huggingface-transformers`, `node-llama-cpp`, `onnxruntime-node`, `pty-manager`, `puppeteer-core`, `react`, `react-dom`, `react-jsx-runtime`, `sharp`, `zlib-sync`.
- PGlite (`@electric-sql/pglite`) replaces Postgres + better-sqlite3 — fully portable, runs in any JS runtime.
- Plugin loading via static `STATIC_ELIZA_PLUGINS` import map instead of `NODE_PATH` scanning.
- `@elizaos/plugin-aosp-local-inference` registers TEXT_SMALL/TEXT_LARGE/TEXT_EMBEDDING handlers backed by the bun:ffi llama loader on AOSP.
- `@elizaos/plugin-capacitor-bridge.ensureMobileDeviceBridgeInferenceHandlers` registers the same handlers backed by the WebView-side Capacitor llama plugin.

What is still missing for iOS in particular:
- The `agent-bundle.js` is built as a **Bun executable** payload, not a WebView module. iOS cannot run it as-is. Either (a) ship a *second* build target that emits an ESM/IIFE consumable by the WebView, or (b) accept that the mobile bundle is a Bun executable on Android only, and write an iOS-specific entry that consumes a smaller set of the same source files in a WebView ESM build.
- No registration glue calls `ensureMobileDeviceBridgeInferenceHandlers` from inside the iOS Capacitor build. The plugin exists; nothing wires it up.
- No persistence of PGlite to disk on iOS. PGlite's default storage is `memory://`. On the WebView, IDB is the persistence backend, which is subject to Apple's eviction. The right answer is **`@capacitor/filesystem` + PGlite's file storage adapter** so the DB lives in `Documents/` (not evictable, backed up to iCloud).
- No `KeyChain`-backed credential storage. `@capacitor/preferences` defaults to `UserDefaults` on iOS, which is not encrypted. Need a Keychain wrapper for any onboarding tokens.

---

## 3. The App Store Entitlement Minefield

What you can and cannot do on iOS, ordered by how badly it'll come back to bite you in review:

### 3.1 Hard prohibitions (App Store rejection on submission)

- **Embedded JIT interpreter** (bun, Node+V8 outside WKWebView). Forbidden.
- **Downloaded executable code** that is then run. This includes downloaded native libraries, downloaded JS that takes over app behavior, downloaded scripts that change the app's core logic. Forbidden by guideline 2.5.2 (the "dynamic code" rule).
- **Programmatic SMS sending.** You can compose with `MFMessageComposeViewController` (user taps Send). You cannot send programmatically. The `@elizaos/capacitor-messages` plugin must be reviewed against this — if it claims to send SMS, it gets rejected.
- **Programmatic phone calls** without `CallKit` and a VoIP entitlement. The `@elizaos/capacitor-phone` plugin claiming to "make calls" is at best a `tel:` URL launcher; anything more is rejected.
- **Background screen capture.** `ScreenCapturePlugin` reading the screen content of other apps — flat-out forbidden. `ReplayKit` allows the user to record their own screen, with broadcast extension. Anything else is rejected.
- **System-wide app blocking** — only `FamilyControls + ManagedSettings + DeviceActivity` (the Screen Time framework). Requires explicit entitlement approval; Apple historically denied this for non-parental-control apps and is only now opening it up.
- **Reading other apps' data** (contacts/messages/photos beyond what the user explicitly shares).
- **Private framework usage.** Anything calling `_-prefixed` APIs is rejected.

### 3.2 Soft prohibitions (likely review pushback or required justification)

- **Background audio** (`UIBackgroundModes: audio`) — allowed if Talk Mode is the primary feature; will be rejected if the audio session is unused for long stretches. Required for talk-mode to survive backgrounding.
- **Background location** — must be obvious in UI why it's needed, and have a usage description that explains it.
- **`NSAppTransportSecurity` with `NSAllowsArbitraryLoads`** — review pushback, must justify; current Podfile uses `iosScheme: "https"` which is good, but check `Info.plist` overlay for any `NSAllowsArbitraryLoadsInWebContent` exception.
- **Family Controls + DeviceActivity** — requires distribution entitlement from Apple (request via developer.apple.com). For parental control apps it's routine; for a personal assistant app, you need a clear "you are restricting your own usage" framing.
- **Long Background Tasks** (`BGProcessingTask` with `requiresNetworkConnectivity` + `requiresExternalPower`) — runs maybe nightly when conditions are met. Fine for training; not fine for "the agent is always listening."
- **`com.apple.developer.usernotifications.communication`** — entitlement for Communication Notifications (notifications that look like an incoming message from a person). Useful for chat UX; requires App Privacy declarations.

### 3.3 Things that look prohibited but actually work

- **Loading a 1-2 GB GGUF into the app sandbox** — totally fine. Apple's concern is *downloading executable code*, not *downloading data*. A GGUF is data, even if the user perceives it as a model.
- **Running LLM inference inside the app process** — fine. `LlamaCppCapacitor` does this. Metal acceleration is fine. CoreML is fine.
- **Streaming JS over WebView postMessage** — fine. The WebView is a sanctioned surface.
- **On-device storage of unlimited size** in `Documents/` (subject to user storage warnings). Subject to iCloud backup (set `URLResourceKey.isExcludedFromBackupKey` for models you don't want backed up).
- **Sharing data across app + extension via App Group** — already wired (`group.com.miladyai.milady`).
- **`AVSpeechSynthesizer`** for TTS — free, no entitlements, no review concerns.
- **`SFSpeechRecognizer`** for STT — works on-device with `requiresOnDeviceRecognition`, but has a per-utterance time limit (~1 min) and requires `NSSpeechRecognitionUsageDescription`.

### 3.4 Background execution on iOS — the hard truth

There is **no Android-equivalent foreground service on iOS**. Period. You get:

- **Foreground audio session** — runs as long as you're producing audio (Talk Mode). Stops when the audio session ends.
- **VoIP / PushKit** — for "incoming call" UX. Apple watches for abuse; if you're not actually making calls, this gets pulled.
- **Significant Location Changes** — wakes the app on geofence transitions. ~10s of execution.
- **`BGAppRefreshTask`** — opportunistic, ~30s execution, no cadence guarantee.
- **`BGProcessingTask`** — longer (minutes), but only when charging + Wi-Fi.
- **APNs background pushes** (`content-available: 1`) — wakes the app for ~30s. Rate-limited.
- **Live Activities** — Dynamic Island / lock-screen presence, but limited to 8h then forcibly closed. Visual only, no compute.

**Consequence:** the "continuous local agent" mental model from desktop doesn't survive iOS. You need a discrete model: agent runs while app is foreground (or in foreground audio/Talk Mode), serializes state to disk, and resumes from the same state when next foregrounded. Push wakes it briefly for time-critical events.

---

## 4. JIT / Runtime Reality Check

**Apple's JIT enforcement.** iOS userspace blocks `mmap` with `PROT_WRITE | PROT_EXEC` for any non-system process. The system grants WKWebView the `dynamic-codesigning` entitlement (private), which lets JavaScriptCore inside the WebView JIT. Apps cannot grant this to themselves on App Store builds.

**What this means concretely:**

| JS runtime                                  | App Store      | Xcode dev install | SideStore           |
|---------------------------------------------|----------------|-------------------|---------------------|
| Bun                                         | ✗ no JIT       | ✗ no JIT          | ✗ requires SideStore + debugger pairing (fragile) |
| Node.js + V8                                | ✗              | ✗                 | ✗ same             |
| Standalone JavaScriptCore (`JSContext`)     | ✓ interpreter only | ✓ interpreter only | ✓ JIT if `get-task-allow` + debugger paired |
| WKWebView (system JSC)                      | ✓ full JIT     | ✓ full JIT        | ✓ full JIT          |
| Hermes (no-JIT mode)                        | ✓              | ✓                 | ✓                   |
| QuickJS                                     | ✓ (interpreter)| ✓                 | ✓                   |
| WebAssembly via WKWebView                   | ✓ full perf    | ✓                 | ✓                   |

**Therefore:** the agent runtime must live in WKWebView (or Hermes / QuickJS, but you'd lose JIT speed for no reason). WKWebView is the answer at every tier. The mobile bundle currently shipped is bun-shaped; we need a WebView-shaped variant.

**SideStore JIT trick.** SideStore can pair with a Mac-side `idevicedebugserverproxy` to grant a sideloaded app JIT in `JSContext` via the `get-task-allow` entitlement. This is real but fragile (requires re-pairing on every device reboot, requires user-side technical setup). It is **not** a path you can promise users.

---

## 5. Three Distribution Tiers — Feature Matrix

What you can ship at each tier, ordered most-restrictive to least-restrictive.

### 5.1 Tier 1: App Store (consumer-installable)

| Capability                              | Available | Notes |
|-----------------------------------------|-----------|-------|
| On-device LLM inference                 | ✓         | LlamaCppCapacitor + GGUF in app bundle or ODR |
| Agent runtime in WebView                | ✓         | WKWebView gets JIT, runs full agent JS |
| PGlite + IndexedDB storage              | ✓         | Use Capacitor Filesystem for DB file persistence |
| KeyChain-backed secrets                 | ✓         | Need a `@capacitor/secure-storage` shim |
| Cloud LLM fallback                      | ✓         | Cloud-hybrid keeps working |
| Talk Mode (foreground audio)            | ✓         | Requires `UIBackgroundModes: audio` + clear primary feature |
| `AVSpeechSynthesizer` TTS               | ✓         | Free, no entitlements |
| On-device STT via `SFSpeechRecognizer`  | ✓         | Per-utterance limit |
| Whisper.cpp STT                         | ✓         | Ship as static framework |
| Camera, contacts, calendar, photos      | ✓         | Each with usage description |
| Location (foreground + always)          | ✓         | Always requires user explanation |
| HealthKit                               | ✓         | `HealthKit` entitlement + usage description |
| Family Controls (app blocker)           | ⚠         | Distribution entitlement; requires Apple approval |
| Safari Content Blocker (website blocker)| ✓         | Already wired |
| Push notifications                      | ✓         | APNs + capability |
| Background fetch (BGAppRefreshTask)     | ✓         | ~30s opportunistic; rotate small jobs |
| Background processing (BGProcessingTask)| ✓         | Charging+Wi-Fi; good for trajectory/training |
| Significant Location wake-ups           | ✓         | For location-triggered automations |
| App Intents + Siri                      | ✓         | Need `AppShortcutsProvider`; ship phrases |
| Universal Links / OAuth callback        | ✓         | Need `applinks:milady.app` + AASA file |
| In-app purchase / subscription          | ✓         | Required for monetization; cannot bypass IAP |
| ScreenTime read-only (Mobile Signals)   | ⚠         | DeviceActivity is read-only; requires entitlement |
| Continuous background agent             | ✗         | Apple prohibits |
| Programmatic SMS send                   | ✗         | |
| Programmatic phone call                 | ✗         | `tel:` URL only |
| Background screen capture               | ✗         | |
| Reading other apps' state               | ✗         | |
| Embedded Bun / Node runtime             | ✗         | |
| Downloading new agent behaviors as code | ✗         | Tools/skills must be in-bundle; can update agent system prompt/config |
| Sideloading third-party plugins         | ✗         | App must ship its own plugin set |

**Headline product on App Store:** "Local AI assistant, on-device chat + voice, your data stays on your phone, optional cloud boost for heavy queries."

### 5.2 Tier 2: Xcode Developer Install (target: ourselves, advanced users)

Everything Tier 1 has, **plus**:

| Capability                              | Available | Notes |
|-----------------------------------------|-----------|-------|
| Larger model bundle (no ODR cap)        | ✓         | Can ship 4 GB GGUF directly |
| Web inspector enabled                   | ✓         | `WKWebView.isInspectable = true` in DEBUG |
| Verbose logging / metrics dashboards    | ✓         | Internal-only |
| Family Controls without entitlement     | ⚠         | Dev provisioning can use; production cannot ship |
| Experimental plugins                    | ✓         | Bake into bundle; not gated by App Review |
| Direct Anthropic / Codex / GitHub OAuth | ✓         | Use `applinks:dev.milady.app` |
| HealthKit broader scopes                | ✓         | Dev entitlement is permissive |
| Custom URL schemes / inter-app coms     | ✓         | |
| Live source-map debugging               | ✓         | Vite dev server over `localhost` |

**Headline:** "Full dev mode — every plugin, every model, every introspection."

### 5.3 Tier 3: Sideload / Alt-Store Distribution

This depends on the channel. There are three legitimate ones:

**3a. AltStore / SideStore** — Free Apple Developer account (7-day signing) or paid ($99/year, 1-year signing). Distribution via altstore.io repos.

- Same entitlement set as Xcode dev (you're using a personal team).
- SideStore can grant `JIT` to apps when paired with a debug server — enables `JSContext` JIT for a smarter agent runtime *if* we ever want one outside the WebView.
- **Practical:** very small user base, technical-user only, re-sign required weekly or yearly.

**3b. Enterprise Distribution (Apple Developer Enterprise Program)** — $299/year, requires a real company entity, in-house distribution only. Apple cracks down hard on consumer abuse (apps get yanked, certificates revoked). Not a viable consumer channel.

**3c. EU DMA Alt Marketplaces** — Post-DMA, EU users can install from third-party marketplaces (AltStore PAL, Setapp Mobile, etc.). Requires:
- EU developer agreement with Apple's "alternative business terms"
- Notarization (Apple still scans the binary, but doesn't approve it for content)
- Core Technology Fee (€0.50 per first install per year after 1M annual installs)
- Restricted to EU residents
- **Practical:** the only consumer-real channel that meaningfully relaxes App Store rules. Family Controls without entitlement, broader API surface, no IAP requirement.

| Capability                              | Tier 3a (SideStore) | Tier 3b (Enterprise) | Tier 3c (EU Alt) |
|-----------------------------------------|---------------------|----------------------|------------------|
| All of Tier 2                           | ✓                   | ✓                    | ✓                |
| JIT in JSContext                        | ✓ (debug paired)    | ✗                    | ✗                |
| Background ops beyond Apple's caps      | ✗                   | ✗                    | ✗ (kernel enforces) |
| Bypass IAP                              | ✗                   | ✓ (in-house only)    | ✓                |
| Family Controls w/o explicit approval   | ✓                   | ✓                    | ✓                |
| Distribute to general public            | ✗ (7-day signing)   | ✗ (in-house only)    | ✓ (EU only)      |
| Time-limited cert                       | 7 days / 1 yr       | 1 yr                 | 1 yr             |

**Headline:** "Sideload gives advanced users a tier-2 experience with no Apple Review delay. EU users get a slightly looser tier on a real distribution channel."

---

## 6. Android Tier Map

Android's tier story is simpler because Google is permissive.

| Tier                | Channel                | What you ship                            | Restrictions |
|---------------------|------------------------|------------------------------------------|--------------|
| Play Store          | Google Play            | Capacitor APK, cloud-hybrid by default; on-device opt-in | Play has its own dynamic-code rule (DexClassLoader of arbitrary code rejected), so the bundled Bun must stay in app-private storage and never load remote DEX/code |
| Play (open-testing) | Play console internal  | Same as Play, faster review              | None additional |
| Direct APK          | GitHub releases / web  | Full local agent, Bun bundled, no Play review | User must enable "Install unknown apps" |
| AOSP image          | Custom Android image   | Privileged-system-app build, no constraints | You ship the OS; this is not a consumer channel |

**Practical recommendation:**
- Play Store APK should match the iOS App Store tier (cloud-hybrid + on-device opt-in).
- "Sideload" on Android = direct APK from the website. Make this an explicit, documented path.
- AOSP is a separate business line (branded device / phone vendor partnerships).

---

## 7. Critical Gaps Ranked by Impact

These are the things actually blocking an end-to-end on-device iOS agent.

1. **No iOS agent entry point.** No code path boots the agent inside WKWebView at app launch. (Highest impact, smallest fix.)
2. **`build-mobile-bundle.mjs` emits a Bun executable, not a WebView ESM module.** Needs a parallel iOS build target. (~1-3 days of work.)
3. **PGlite persistence on iOS is in-WebView IDB by default — Apple will evict it under storage pressure.** Need Capacitor Filesystem-backed PGlite. (~1 day.)
4. **`ensureMobileDeviceBridgeInferenceHandlers` is never called on iOS.** The plugin exists; the boot sequence doesn't wire it. (~1 hour.)
5. **No model file ships in the iOS bundle.** ODR script `stage-models-odr.mjs` is documented but unimplemented. For a first-light we can just ship a small GGUF as a regular bundle resource. (~2 hours.)
6. **`LlamaCppCapacitor.swift` doesn't call `NSBundleResourceRequest`.** Until we move to ODR this doesn't matter, but it blocks the path to ship larger models. (~1 day.)
7. **No KeyChain-backed secret storage.** Onboarding tokens stored in plaintext. (~1 day.)
8. **OAuth callback isn't wired in `AppDelegate`.** Blocks Anthropic/Codex onboarding in cloud-hybrid mode. (~2 hours.)
9. **No `BGTaskScheduler` registration.** Blocks trajectory rotation / auto-training while backgrounded. (~1 day.)
10. **No simulator-tested model path.** The "fastest model that works on iPhone simulator" question is unanswered. (~2 hours, mostly research.)
11. **Privacy manifest (`PrivacyInfo.xcprivacy`) might be incomplete.** Required since iOS 17 and review will reject if the listed reasons don't match actual API usage. (~2 hours audit.)
12. **`Info.plist` doesn't enable `UIBackgroundModes: audio`.** Talk Mode dies on backgrounding. (~10 minutes.)
13. **App Intents + Siri (`ElizaIntentPlugin.swift`) is theoretical.** No `AppShortcutsProvider`. (~2 days for a small but real set of intents.)
14. **No "developer mode" vs "App Store" build flag.** All builds get the same entitlements and asset set. Need a `MILADY_DISTRIBUTION_TIER` env (`appstore` / `developer` / `sideload`) that gates which plugins, models, and entitlements are included. (~1 day plus the actual gating logic.)

Items 1, 2, 3, 4, 5 are the **end-to-end local agent path**. Everything else is hardening or differentiating tiers.

---

## 8. Implementation Plan

### 8.1 Phase 0 — Decisions (this audit's deliverable)

- **iOS agent runs in WKWebView.** Same JSC instance as the React UI. No separate JS engine, no Bun.
- **Cloud-hybrid stays.** Tier 1 (App Store) defaults to local with cloud fallback for heavy queries. Tier 2/3 default to local-only.
- **First-light model:** Qwen2.5-0.5B-Instruct Q4_K_M (~400 MB) or Llama-3.2-1B-Q4_K_M (~770 MB). 0.5B fits in Tier 1 cleanly. Bundle it as `app/agent/models/first-light.gguf`.
- **Storage:** PGlite over Capacitor Filesystem in `Documents/.milady/`. Mark `isExcludedFromBackupKey` on the models subdirectory.
- **Secrets:** new `@elizaos/capacitor-secure-storage` plugin wrapping iOS KeyChain / Android Keystore.
- **Distribution tiers:** new build-time env `MILADY_DISTRIBUTION_TIER` (`appstore` | `developer` | `sideload`). Used by `run-mobile-build.mjs` to:
  - Pick a different `Info.plist` overlay (different `UIBackgroundModes`, different `UIRequiredDeviceCapabilities`)
  - Pick a different set of plugins (developer tier includes additional dev/test plugins)
  - Pick a different model set (developer tier includes larger models, no ODR)
  - Pick a different `App.entitlements` (developer tier includes Family Controls dev entitlement when present)

### 8.2 Phase 1 — End-to-End First Light (this PR)

Smallest possible "iPhone simulator loads a model, user types, agent responds." Concretely:

1. Add `build-mobile-bundle.mjs` a second emission mode: `--target=webview`, emitting ESM that imports cleanly into the React app.
2. Add `apps/app/src/runtime/ios-agent-boot.ts` that, when the Capacitor platform is iOS, dynamically imports the WebView ESM agent bundle and starts it.
3. Wire `ensureMobileDeviceBridgeInferenceHandlers` into the iOS boot path.
4. Wire `@electric-sql/pglite` to a Capacitor Filesystem-backed file under `Documents/.milady/db.pglite`.
5. Ship a tiny GGUF (Qwen2.5-0.5B-Q4_K_M) under `apps/app/ios/App/App/agent/models/first-light.gguf`. Bundle it as an Xcode resource.
6. Add the simulator-build target and a `bun run ios:simulator` script that overlays, pod-installs, and launches.
7. Wire the chat UI to call the in-process agent rather than the cloud endpoint when iOS local mode is detected.
8. Confirm: in Simulator, user types "hello", model generates a reply.

This is the minimum end-to-end. Voice, tools, planning beyond a single response — phase 2.

### 8.3 Phase 2 — Tier feature parity

- KeyChain-backed secure storage plugin.
- BGTaskScheduler + BGAppRefreshTask for trajectory rotation.
- `UIBackgroundModes: audio` + Talk Mode pipeline tested with real backgrounding.
- App Intents + Siri shortcuts for "Ask Milady …".
- Universal Link OAuth callback for Anthropic / Codex / Cloud onboarding.
- Privacy manifest audit + complete reasons list.
- ODR migration so larger models can be downloaded post-install.

### 8.4 Phase 3 — Distribution tier differentiation

- `MILADY_DISTRIBUTION_TIER` env switches.
- Three different `Info.plist`/`App.entitlements` overlay paths.
- CI lanes for each tier: TestFlight (appstore), Xcode archive (developer), AltStore IPA (sideload).
- EU DMA alt-marketplace lane gated on `MILADY_DMA_REGION=eu`.

### 8.5 Phase 4 — Android parity-or-better

- Make `build:android:cloud` (Play Store) opt-in to local-first by default, matching iOS Tier 1.
- Document direct-APK sideload as a first-class user channel.
- AOSP build remains a separate vertical.

---

## 9. Hard Truths and Strong Recommendations

1. **Delete the "iOS cannot run an agent" narrative.** It cost you months and is wrong. The agent runs in WKWebView. WKWebView gets JIT. There is no Apple rule against it.
2. **Stop building a Bun-shaped mobile bundle when iOS exists.** The fact that the same `agent-bundle.js` would have to be a Bun executable on Android-AOSP and a WebView ESM on iOS is awkward; either build two emissions or commit to the WebView-shaped bundle and have AOSP load it through Bun's CommonJS interop. Today's design is "Android-shaped, iOS-bolted-on" and the bolt is missing.
3. **`@elizaos/capacitor-phone`, `@elizaos/capacitor-messages`, `@elizaos/capacitor-screencapture` will not pass App Review.** Audit each one. If they can be reframed (`MFMessageComposeViewController`, `tel:` launch, `ReplayKit` user-initiated recording), do so. Otherwise gate them behind `MILADY_DISTRIBUTION_TIER != appstore`.
4. **Stop using `localStorage` for tokens.** It's not encrypted on iOS. The KeyChain wrapper is a one-day fix.
5. **The "continuous background agent" mental model dies on iOS.** Plan accordingly. The product is a foreground agent + push-wake + opportunistic background fetch. Anything else is fighting the OS.
6. **You're not ready for App Review.** The Privacy manifest is half-done. The OAuth callback is missing. App Intents are empty. `Info.plist` overlay is incomplete. Submit too early and you eat 1-2 weeks of rejection cycles. Fix the gaps first.
7. **The Android "sideload APK" channel is not yet a real product.** Make it one. Docs page, signed APK on GitHub releases, in-app updater. Otherwise you're shipping Play Store only and the AOSP variant is a different business.
8. **`run-mobile-build.mjs` is 3,993 lines and growing.** Half of it is iOS-specific surgery on `project.pbxproj`. This is fine for now, but it's a single point of failure. When it gets to 5K lines, split it into per-platform modules.
9. **Simulator end-to-end test should be a CI gate.** A simulator-build that launches the app, sends a message, and asserts a response will catch 80% of regressions. The fact that this doesn't exist today is the reason the iOS path has rotted.
10. **Document the three tiers as a user-facing matrix.** "Here's what you get on the App Store, here's what you get with TestFlight, here's what you get if you install via Xcode or AltStore." Users will pick a tier; the product should make the choice legible.

---

## 10. Definition of Done for "End-to-End iOS Local Agent"

- iPhone Simulator on Apple Silicon Mac.
- App boots, agent JS initializes inside WKWebView.
- PGlite database opens in `Documents/.milady/`.
- LlamaCppCapacitor loads `first-light.gguf` (Qwen2.5-0.5B Q4) from app bundle.
- User types "hello" in the chat UI.
- Agent runtime receives the message, plans (single-step), calls TEXT_LARGE handler, the handler routes through `capacitor-bridge` to the loaded model, generates tokens, returns to UI.
- UI renders the streamed response.
- App can be re-launched and prior messages persist in PGlite.
- Reproducible: `bun run ios:simulator` from a fresh checkout, no manual Xcode steps.

When this is true, the iOS local agent is real. Everything else is hardening, tiers, and feature parity. Phase 1 of section 8.2 is the path.

---

## Appendix A — "Compile Bun for iOS and embed it" — Feasibility

The user asked for a thorough look at compiling Bun for iOS and embedding it, with `fs` calls etc. erroring gracefully on the iOS sandbox. Three parallel research passes (Bun build system + JSC JIT, alternative embedded JS runtimes, real Node API surface across our code) produced a cohesive picture. Honest verdict:

### A.1 Three things the research established

**1. Bun has no iOS port, and the project is mid-rewrite.**
- `oven-sh/bun#339` (mobile build) was closed *not planned*.
- `oven-sh/bun#9436` (iOS discussion, March 2024) has zero maintainer engagement; the one community Swift-bridge experiment was abandoned.
- There is no Android port either — Bun has never been built for any mobile OS.
- Anthropic acquired Bun on 2 December 2025 and the team is **trialing a Zig→Rust rewrite**. Any port done against today's Zig codebase is rebasing onto sand.

**2. JIT-less JSC on iOS is well-understood (this part is real).**
- JSC has a no-JIT mode: `ENABLE_JIT=0` at build, `JSC::Options::useJIT() = false` at runtime. Falls back to LLInt interpreter. Used by NativeScript, RN-JSC, node-jsc.
- Performance hit: ~7.5× slower on compute (Coote 2020 benchmark). For our agent (mostly I/O, JSON, prompt assembly, native LLM calls), the practical hit is more like 2-3× — bearable, not great.
- WKWebView gets full JIT via Apple's WebKit entitlement. Anything *outside* WKWebView (a separate `JSContext` or embedded JSC in Bun's binary) runs LLInt-only.

**3. Our actual Node API surface is tiny.**

Real grep counts across `eliza/packages/core`, `eliza/packages/agent`, `eliza/packages/app-core`, `eliza/plugins`, and `packages/`:

| API                | Files using it | Classification           |
|--------------------|----------------|--------------------------|
| `process.env`      | 705            | PORTABLE                 |
| `process.cwd/argv` | 149            | PORTABLE                 |
| `EventEmitter`     | 17             | PORTABLE (polyfill)      |
| `Bun.spawn`        | 14             | SHIM (throw on iOS)      |
| `bun:ffi`          | 13             | SHIM (static symbols only) |
| `Bun.build`        | 63             | STUB (build-time only, never runtime) |
| `fs` (any)         | **4**          | SHIM                     |
| `Bun.file`         | 3              | SHIM                     |
| `path`             | 3              | PORTABLE                 |
| `os`               | 2              | SHIM                     |
| `crypto.randomUUID`| 1              | PORTABLE                 |
| `Bun.serve`        | **1**          | STUB (game plugin only)  |
| `url.fileURLToPath`| 2              | PORTABLE                 |

The agent core does not depend on the Node-shaped surface in any meaningful way. The 705 `process.env` count is a one-liner shim. `fs` is used in 4 files — video temp files, training CLI, build-time tooling. **`Bun.serve` is used in exactly one file**, in a game plugin (`app-2004scape`). The whole "we need Bun to run the agent" framing turns out to be wrong because we already wrote the agent for a browser-shaped runtime.

### A.2 Cost matrix

| Path                                          | Eng-weeks | Binary cost | Perf class      | Risk                              |
|-----------------------------------------------|-----------|-------------|-----------------|-----------------------------------|
| **Port Bun to iOS (custom)**                  | 16–24+    | +8–15 MB    | JSC LLInt (~7×) | Highest. Bun is mid-rewrite; you're maintaining a fork forever |
| **nodejs-mobile + Bun-shape shim**            | 4–8       | +10–15 MB   | V8 jitless (~3×) | Medium. nodejs-mobile is dormant (last release Oct 2024, Node 18 EOL April 2025) |
| **System JSC (`JSContext`) + Bun+Node shim**  | 4–8       | 0           | JSC LLInt (~7×) | Medium. ~6–10k LOC of polyfills + Swift bridges to write |
| **Agent in WKWebView (in-process or Worker)** | **1–2**   | **0**       | **Full JIT**    | **Lowest.** Agent already uses ~zero Node APIs |

### A.3 What "fs calls etc. error gracefully" actually means

Across all four paths above, the strategy is the same: **stub the unportable Node surface with a small shim file that throws helpful errors.** The mobile-stubs directory already does this for `sharp`, `canvas`, `onnxruntime-node`, `node-llama-cpp`, `pty-manager`, `puppeteer-core`. We extend the same pattern:

- `child_process.spawn` / `Bun.spawn` → throws `Error("spawn is not available on iOS — agent runs in-process")`.
- `fs.watch` → throws (rarely used).
- `bun:ffi.dlopen("/path/to.dylib")` → throws unless the path is a known statically-linked symbol allow-list.
- `os.homedir()` → returns iOS app sandbox `~/Library/Application Support/Milady`.
- `os.tmpdir()` → returns `NSTemporaryDirectory()`.
- `fs.readFile / writeFile / mkdir / readdir / stat` → routes through `@capacitor/filesystem` (already a dep) or directly to system calls in the embedded runtime case.

The shim work is **the same code regardless of which runtime we pick** — because the agent code is what calls these APIs. Picking Bun-on-iOS vs WKWebView only changes where the shim is hosted.

### A.4 The hard truth about porting Bun to iOS

Even setting aside the Zig→Rust rewrite uncertainty, the actual work is:

1. **Cross-build WebKit's JSC as a static lib for iOS without private APIs** (2–3 weeks; recipes exist in `node-jsc`, NativeScript). With `ENABLE_JIT=0`, `ENABLE_DFG_JIT=0`, `ENABLE_FTL_JIT=0`, `ENABLE_WEBASSEMBLY_BBQJIT=0`.
2. **Cross-build every other native dep**: BoringSSL, c-ares, lolhtml, zstd, mimalloc, libuv. 1–2 weeks.
3. **Wire `aarch64-ios` and `aarch64-ios-simulator` Zig targets** into Bun's `build.zig` + CMake. 2 weeks. The Zig support is there since 0.10; Bun's build config is not.
4. **Refactor `main()` → `bun_embedded_run()` C ABI.** Bun's process-init owns the process today. 1–2 weeks.
5. **Audit every `posix_spawn` / `fork` / TinyCC / arbitrary-`dlopen` site** and stub or remove. **3–4 weeks. This is the long pole.** Bun assumes desktop OS semantics in many places.
6. **Refactor `bun:ffi`** to allow only statically-linked symbols (no TinyCC `cc`, no `dlopen` of arbitrary paths). Could be a feature flag.
7. **First simulator boot + first device boot + sandbox path correctness + signals + kqueue + crypto entropy.** 4–6 weeks.
8. **App Review pass.** Expect 1–2 rejection round-trips.
9. **Permanent rebase tax** onto upstream Bun's weekly releases. Forever.

Realistic total: **4–6 engineer-months minimum, 9–12 if anything goes wrong.** And "anything goes wrong" is the base case for a port of this complexity against an unsupportive upstream and a runtime mid-rewrite.

For comparison: the **WKWebView agent path is 1–2 engineer-weeks**.

### A.5 Recommendation (revised)

**Do not port Bun to iOS.** Run the agent in the existing WKWebView. The justification is no longer "JIT is forbidden outside the WebView" — the JIT issue is real but solvable. The justification is:

1. **Bun is the wrong abstraction for the agent.** We thought it was a hard dependency. The grep proves it's not. The agent uses `process.env`, `EventEmitter`, `Buffer`, `path`, `crypto.randomUUID`, and a handful of Bun-specific globals (`Bun.serve`, `Bun.file`) which are 200 LOC of trivial shimming. There is no `child_process` in the agent core. There are no `worker_threads`. There is no `bun:ffi` outside the Android-specific AOSP llama loader (which is already gated by `ELIZA_LOCAL_LLAMA=1`).
2. **The mobile bundle already does most of this work.** `build-mobile-bundle.mjs` produces a static ESM-like bundle with no `node_modules` at runtime, statically inlined plugins via `STATIC_ELIZA_PLUGINS`, and mobile stubs replacing the heavy native modules. We add **one more emission target** — `--target=webview` — that swaps the remaining Node-shaped stubs for browser-shaped ones, and the bundle imports cleanly into the React app's JS.
3. **WKWebView gives us full-tier JSC JIT for free.** No engine to ship. No App Review surprise. No fork to maintain.
4. **The performance ceiling is set by llama.cpp on Metal, not by the JS runtime.** The JS does prompt assembly, planner state, tool dispatch — all of which is dwarfed by the actual LLM token generation in Metal shaders.
5. **The "we lose Bun.serve" problem is a non-problem.** Bun.serve is used in one file in the entire codebase, in a game plugin. The agent's HTTP API surface in mobile mode can be served by in-process function calls instead of a loopback HTTP server. The WebView UI talks to the agent via `postMessage` or direct function imports, not via `fetch('http://localhost:31337')`.

The only argument for porting Bun would be **API compatibility for future plugins that assume Bun globals**. That's a real concern but the right answer is a 200-LOC `Bun` polyfill shipped with the WebView bundle, not 5 months of build-system work.

### A.6 If you still want a Bun-on-iOS path

I'll be wrong about the WKWebView path eventually — there will be a plugin that genuinely needs full Node semantics. When that happens, the staircase is:

- **Tier A (today):** Agent in WKWebView. Bun-polyfill (~200 LOC) for `Bun.serve` / `Bun.file`. Browser-shape `fs` over Capacitor Filesystem. ~95% of plugins work.
- **Tier B (when A breaks):** Add **nodejs-mobile** as a second runtime, used by plugins that genuinely need full Node. The React UI talks to the nodejs-mobile worker over a JSI bridge or a loopback socket. 4–8 engineer-weeks.
- **Tier C (when B is insufficient):** Reconsider the Bun port at that point, against post-rewrite Rust Bun. Likely never needed.

We have nodejs-mobile as a backstop. We do not need to commit to it preemptively. We do not need to commit to the Bun port at all.

### A.7 Bottom line

The user's instinct ("compile Bun to iOS and just make sure fs calls etc. error") was correct in spirit (use the same agent code, error gracefully on what doesn't work) but wrong in mechanism (Bun-the-runtime is not the actual dependency). The agent's only meaningful Bun dependence is on **the Bun build system as a TypeScript-to-static-bundle compiler** — which we use offline, on a Mac, before shipping. The runtime side of Bun is barely touched by our code.

The right read of this is: **the iOS port is a mobile bundle build variant and a small polyfill, not a runtime port.** We are ~2 engineer-weeks from end-to-end on-device on iOS Simulator. The Bun-port path is 5 months. Pick the 2 weeks.

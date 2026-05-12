# Launch Readiness 07: Android Build And QA

## Second-Pass Status (2026-05-05)

- Superseded: `build:android:system` is now present at the repo root and in `packages/app/package.json`.
- Still open: mobile device-bridge embedding requests are mismatched with the device client, Android smoke CI still appears to install SDK 34 while the project compiles SDK 36, and legacy release signing workflow drift remains.
- Launch gate: static mobile artifact checks pass; emulator, physical device, Cuttlefish/AOSP, Play upload, foreground service, Doze, logcat, SELinux, and cloud-hybrid embedding tests remain unvalidated.

## Current state

Android is a real Capacitor app under `packages/app`, with current app identity `ai.elizaos.app` / `elizaOS` (`packages/app/app.config.ts:21-30`, `packages/app/capacitor.config.ts:4-24`). The Gradle project targets minSdk 26, compileSdk 36, targetSdk 35, Java 21, AGP 9.2.0, and Kotlin 2.3.21 (`packages/app/android/variables.gradle:1-17`, `packages/app/android/build.gradle:17-30`, `packages/app/android/build.gradle:46-59`).

The app has Android foreground services for the gateway keepalive and the local agent runtime (`packages/app/android/app/src/main/AndroidManifest.xml:32-44`). `MainActivity` starts both on app open and explicitly enables mixed-content loopback fetches for the local HTTP agent (`packages/app/android/app/src/main/java/ai/elizaos/app/MainActivity.java:61-89`). `ElizaAgentService` unpacks the Bun/musl/agent assets, starts the agent on `127.0.0.1:31337`, requires a per-boot bearer token, and enables the local inference device bridge (`packages/app/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java:623-675`).

The mobile UX supports `remote-mac`, `cloud`, `cloud-hybrid`, and `local` runtime modes (`packages/app-core/src/onboarding/mobile-runtime-mode.ts:16-52`). Android local mode persists a loopback active server (`packages/app-core/src/components/shell/RuntimeGate.tsx:439-472`), ElizaOS/AOSP fresh boots can pre-seed local mode (`packages/app-core/src/onboarding/pre-seed-local-runtime.ts:85-91`), cloud mode persists a cloud active server (`packages/app-core/src/components/shell/RuntimeGate.tsx:396-434`), and remote gateway/manual URL paths are wired (`packages/app-core/src/components/shell/RuntimeGate.tsx:497-535`, `packages/app-core/src/components/shell/RuntimeGate.tsx:1011-1088`).

The AOSP distro tree exists under `packages/os/android/vendor/eliza`, imports `Eliza.apk` as a privileged platform-signed system app, strips/replaces stock role apps, sets default role overlays, and ships default/privapp permission XML (`packages/os/android/vendor/eliza/apps/Eliza/Android.bp:14-56`, `packages/os/android/vendor/eliza/eliza_common.mk:22-86`, `packages/os/android/vendor/eliza/permissions/default-permissions-ai.elizaos.app.xml:1-36`, `packages/os/android/vendor/eliza/permissions/privapp-permissions-ai.elizaos.app.xml:1-31`).

## Evidence reviewed with file refs

- App scripts and dependencies: `packages/app/package.json:5-27`, `packages/app/package.json:29-93`.
- Capacitor config and native Android config: `packages/app/capacitor.config.ts:4-49`, `packages/app/android/app/build.gradle:3-123`, `packages/app/android/build.gradle:17-30`, `packages/app/android/variables.gradle:1-17`.
- Android manifest, services, permissions: `packages/app/android/app/src/main/AndroidManifest.xml:8-75`.
- Local agent service: `packages/app/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java:33-142`, `packages/app/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java:257-467`, `packages/app/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java:620-889`.
- Gateway foreground service and native gateway plugin: `packages/app/android/app/src/main/java/ai/elizaos/app/GatewayConnectionService.java:16-83`, `packages/native-plugins/gateway/android/src/main/java/ai/eliza/plugins/gateway/GatewayPlugin.kt:54-193`, `packages/native-plugins/gateway/android/src/main/java/ai/eliza/plugins/gateway/GatewayPlugin.kt:329-614`.
- Local-agent native HTTP/token bridge: `packages/app-core/src/onboarding/local-agent-token.ts:15-70`, `packages/app-core/src/api/android-native-agent-transport.ts:66-120`, `packages/native-plugins/agent/android/src/main/java/ai/eliza/plugins/agent/AgentPlugin.kt:27-73`, `packages/native-plugins/agent/android/src/main/java/ai/eliza/plugins/agent/AgentPlugin.kt:75-150`.
- Cloud/local/remote runtime UX: `packages/app-core/src/onboarding/mobile-runtime-mode.ts:4-85`, `packages/app-core/src/onboarding/pre-seed-local-runtime.ts:21-91`, `packages/app-core/src/components/shell/RuntimeGate.tsx:396-535`, `packages/app/src/main.tsx:320-336`, `packages/app/src/main.tsx:744-821`, `packages/app/src/ios-runtime.ts:1-95`.
- Remote gateway discovery: `packages/app-core/src/bridge/gateway-discovery.ts:51-91`, `packages/native-plugins/gateway/android/src/main/java/ai/eliza/plugins/gateway/GatewayPlugin.kt:54-193`.
- Device bridge/local inference: `packages/native-plugins/llama/src/device-bridge-client.ts:28-71`, `packages/native-plugins/llama/src/device-bridge-client.ts:214-296`, `packages/app-core/src/services/local-inference/device-bridge.ts:66-112`, `packages/app-core/src/services/local-inference/device-bridge.ts:800-861`, `packages/app-core/src/services/local-inference/device-bridge.ts:1034-1060`, `packages/app-core/src/runtime/ensure-local-inference-handler.ts:335-360`, `packages/app-core/src/runtime/ensure-local-inference-handler.ts:429-457`.
- Android build orchestrator and agent staging: `packages/app-core/scripts/run-mobile-build.mjs:508-608`, `packages/app-core/scripts/run-mobile-build.mjs:1641-1699`, `packages/app-core/scripts/run-mobile-build.mjs:1787-1835`, `packages/app-core/scripts/run-mobile-build.mjs:1882-1928`, `packages/app-core/scripts/lib/stage-android-agent.mjs:1-83`.
- AOSP distro scripts and vendor tree: `scripts/distro-android/build-aosp.mjs:1-15`, `scripts/distro-android/build-aosp.mjs:192-240`, `scripts/distro-android/brand.eliza.json:1-16`, `scripts/distro-android/validate.mjs:221-260`, `scripts/distro-android/validate.mjs:520-608`.
- CI/release workflows: `.github/workflows/mobile-build-smoke.yml:126-203`, `.github/workflows/build-android.yml:18-126`, `.github/workflows/android-release.yml:48-174`, `.github/workflows/android-release.yml:176-258`.
- Stale docs compared against code: `docs/apps/mobile.md:16-35`, `docs/apps/mobile.md:490-556`, `docs/agent-on-mobile.md:60-75`.

## What I could validate

- Local static toolchain presence: Bun 1.3.13, Node v22.20.0, Java 21.0.10, and Android SDK build-tools 33.0.2/34.0.0/35.0.0/36.0.0 are present locally.
- The AOSP vendor tree's XML/product/default-permission/sepolicy static validator subset passes.
- `init.eliza.rc` passes the distro init.rc linter.
- Focused unit coverage around the Android/mobile pieces mostly passes:
  - `run-mobile-build.test.ts`
  - `stage-android-agent.test.ts`
  - `android-native-agent-transport.test.ts`
  - `mobile-local-inference-gate.test.ts`
  - `ios-runtime.test.ts`
  - `device-bridge.test.ts`
  - `ensure-local-inference-handler.test.ts`
  - `mobile-runtime-mode.test.ts` passes when run with Vitest/jsdom.
- The loopback auth gap appears addressed in current code: Android local agent sets `ELIZA_REQUIRE_LOCAL_AUTH=1`, generates a token, persists it mode 0600, and the native plugin injects `Authorization: Bearer <token>` for local-agent requests (`ElizaAgentService.java:623-669`, `AgentPlugin.kt:65-111`).
- Remote-to-desktop-agent support is present at the UX/native-plugin layer via mDNS discovery and manual remote URL/token entry.
- Remote-to-cloud-agent/cloud-hybrid support is present at the UX/bootstrap layer: mobile can resolve a cloud agent API base and start a device bridge client for `cloud-hybrid` or `local` (`packages/app/src/main.tsx:755-821`).

## What I could not validate

- I did not run `bun run --cwd packages/app build:android`, Gradle, Android Studio, emulator, Cuttlefish, or AOSP `m`. Those steps write/generate many files and can be long-running.
- I did not produce or inspect an APK/AAB, so I could not validate actual manifest merge output, asset thinning, APK size, R8/proguard behavior, signing, bundle splits, or Play upload.
- I did not boot a physical Android device, emulator, or Cuttlefish image, so I could not validate foreground service permissions, Doze/background survival, local agent startup, logcat/SELinux/seccomp behavior, default role assignment, mDNS discovery, notification UX, camera/mic/location/runtime permission prompts, or actual llama performance.
- I did not test real Eliza Cloud credentials, Play Store credentials, Android keystore credentials, Firebase/google-services push configuration, or remote desktop gateway credentials.
- I did not validate remote-to-cloud-agent and remote-to-desktop-agent end to end with real network services; review was static plus unit tests.

## Build/test commands attempted/results

- `node scripts/distro-android/lint-init-rc.mjs packages/os/android/vendor/eliza/init/init.eliza.rc`
  - Result: passed, printed `OK`.
- `node --input-type=module -e '... validateXmlFiles/validateProductLayer/validateDefaultPermissions/validateSepolicy ...'`
  - Result: passed XML parse, product layer, permission XML, and sepolicy checks.
- `bun --version`, `node --version`, `java -version`
  - Result: Bun 1.3.13, Node v22.20.0, Java 21.0.10.
- SDK check via shell listing:
  - Result: Android build-tools 33.0.2, 34.0.0, 35.0.0, and 36.0.0 are installed locally.
- `bun run build:android:system`
  - Result: superseded by current code; this script now exists at the repo root and in `packages/app/package.json`.
- `bun test packages/app-core/scripts/run-mobile-build.test.ts packages/app-core/scripts/lib/stage-android-agent.test.ts packages/app-core/test/onboarding/mobile-runtime-mode.test.ts packages/app-core/src/api/android-native-agent-transport.test.ts packages/app-core/src/runtime/mobile-local-inference-gate.test.ts packages/app/test/ios-runtime.test.ts packages/app-core/src/services/local-inference/device-bridge.test.ts packages/app-core/src/runtime/ensure-local-inference-handler.test.ts`
  - Result: failed only in `mobile-runtime-mode.test.ts` because that file is Vitest/jsdom-only and the direct Bun runner had no `window`; the other selected Android/mobile tests completed as passing before the failure summary.
- `bunx vitest run packages/app-core/test/onboarding/mobile-runtime-mode.test.ts --config packages/app-core/vitest.config.ts`
  - Result: passed, 1 file / 6 tests.
- `bun test --coverage=false ...`
  - Result: command invocation failed because Bun's `--coverage` flag does not take a value; not a product test.

## Bugs/risks P0-P3

### P0

- None found in this bounded review.

### P1

- Superseded: the AOSP rebuild command now exists as `bun run build:android:system` at the repo root and in `packages/app/package.json`. The remaining launch risk is validating the generated privileged APK inside Cuttlefish/AOSP rather than script discovery.
- Cloud-hybrid/device-bridge embeddings are mismatched. The agent-side bridge sends `embed` and registers an embedding-capable loader (`packages/app-core/src/services/local-inference/device-bridge.ts:84-112`, `packages/app-core/src/services/local-inference/device-bridge.ts:800-861`, `packages/app-core/src/services/local-inference/device-bridge.ts:1034-1060`), and `ensureLocalInferenceHandler` registers `TEXT_EMBEDDING` when the loader exposes `embed` (`packages/app-core/src/runtime/ensure-local-inference-handler.ts:429-457`). The mobile device-side client only handles `load`, `unload`, `generate`, and `ping`, and has no `embed` inbound/result handling (`packages/native-plugins/llama/src/device-bridge-client.ts:28-71`, `packages/native-plugins/llama/src/device-bridge-client.ts:214-296`). Any cloud-hybrid/local-embeddings request routed to a mobile device can time out.

### P2

- The checked-in Android Gradle tree is not the same as the orchestrated build tree. `run-mobile-build.mjs` injects noCompress and app-thinning hooks (`packages/app-core/scripts/run-mobile-build.mjs:508-608`, `packages/app-core/scripts/run-mobile-build.mjs:1686-1688`), but checked-in `packages/app/android/app/build.gradle` lacks the `[app-thinning]` block and only lists `gguf`/`so` in `noCompress` (`packages/app/android/app/build.gradle:69-86`). Direct Gradle/Android Studio builds from the checked-in tree can diverge from CI/orchestrated builds and may package stale `assets/agent/` payloads into Play artifacts.
- Android smoke CI installs SDK platform/build-tools 34 while the project compiles against SDK 36 (`.github/workflows/mobile-build-smoke.yml:146-150`, `packages/app/android/variables.gradle:1-5`). This is a likely CI drift point unless the action implicitly installs 36 elsewhere.
- Legacy `.github/workflows/build-android.yml` release signing looks unsafe. The release Gradle step does not provide the `ELIZAOS_KEYSTORE_*` env vars consumed by `packages/app/android/app/build.gradle:33-53`, and the manual APK signing step checks `env.ANDROID_KEYSTORE_BASE64` even though that value is only set in the step env (`.github/workflows/build-android.yml:97-126`). The newer `.github/workflows/android-release.yml` is better wired, but the legacy workflow can still upload misleading release artifacts.
- The native Agent plugin reflection is hardcoded to `ai.elizaos.app.ElizaAgentService` (`packages/native-plugins/agent/android/src/main/java/ai/eliza/plugins/agent/AgentPlugin.kt:65-73`). Current elizaOS matches, but white-label app IDs/namespaces generated by `run-mobile-build.mjs` would lose local-agent token hydration and native local HTTP routing unless this is made dynamic.
- AOSP SELinux state is intentionally broad and internally inconsistent in docs/comments. Current policy allows any `platform_app` to execute any `app_data_file` (`packages/os/android/vendor/eliza/sepolicy/eliza_agent.te:21-32`), while `packages/os/android/vendor/eliza/sepolicy/README.md:22-88` still describes a custom `eliza_agent` domain transition and old `com.elizaai.eliza` data paths. This needs a production user-build security pass.

### P3

- Mobile docs are stale: app ID/package name, compile SDK, JDK version, and namespace still show older values (`docs/apps/mobile.md:16-35`, `docs/apps/mobile.md:490-556`) while code uses `ai.elizaos.app`, compileSdk 36, and Java 21.
- `docs/agent-on-mobile.md` still references `/data/data/com.elizaai.eliza` and older package names (`docs/agent-on-mobile.md:60-75`).
- Gradle version sources drift: checked-in wrapper is Gradle 9.5.0, but `run-mobile-build.mjs` rewrites it to 9.4.1 (`packages/app/android/gradle/wrapper/gradle-wrapper.properties:1-7`, `packages/app-core/scripts/run-mobile-build.mjs:1548-1560`).
- Root Android Gradle ext values are stale/inconsistent: classpath uses AGP 9.2.0 but `androidGradlePluginVersion` still says 8.13.0 (`packages/app/android/build.gradle:17-30`).
- `run-mobile-build.mjs` appends `com.google.code.gson:gson:2.13.2` when that exact string is absent (`packages/app-core/scripts/run-mobile-build.mjs:1674-1677`), while checked-in Gradle already has Gson 2.14.0 (`packages/app/android/app/build.gradle:100-107`). Running the patcher can add a duplicate lower-version declaration.

## Codex-fixable work

- Add a root or `packages/app` script for `build:android:system` that calls `node packages/app-core/scripts/run-mobile-build.mjs android-system`, or update `scripts/distro-android/brand.eliza.json` to call the existing node command directly.
- Add `embed` handling to `packages/native-plugins/llama/src/device-bridge-client.ts`, with tests proving a real mobile device client responds to agent-side `embed` messages.
- Make `AgentPlugin.kt` resolve the app service class dynamically from the Capacitor app package/namespace, or expose token retrieval through a small app-side Android interface registered without hardcoded package names.
- Bring checked-in Android Gradle files into agreement with `run-mobile-build.mjs`, or make direct Gradle invocations fail fast with a clear "run the mobile build orchestrator first" guard.
- Align Android SDK versions in `.github/workflows/mobile-build-smoke.yml` with compileSdk 36.
- Either remove/deprecate `.github/workflows/build-android.yml` or wire it to the same signing/versioning path as `.github/workflows/android-release.yml`.
- Update mobile/AOSP docs to current app ID, package name, SDK/JDK versions, and `/data/data/ai.elizaos.app` paths.
- Clean up Gradle version drift and duplicate dependency patching logic.

## Human/device/Play Store/credential QA needed

- Physical Android device QA: install debug/release builds, launch cold/warm, grant/deny notifications, verify foreground service notifications, local agent health, chat, background/Doze survival, app swipe-kill behavior, logcat cleanliness, and battery/thermal impact.
- AOSP/Cuttlefish QA: run `android-system` build, stage `Eliza.apk`, boot Cuttlefish, verify default HOME/Dialer/SMS/Assistant/Browser roles, boot receiver, usage-stats/appops grants, SELinux denials, seccomp/SIGSYS logs, and local llama generation on x86_64.
- Play Store QA: signed AAB build, upload keystore, Play App Signing enrollment, package name `ai.elizaos.app`, versionCode monotonicity, internal track upload, app size/download size, permissions declaration, foreground service special-use declaration, data safety, background location justification if shipped, and privacy policy links.
- Cloud/remote QA: real Eliza Cloud login, cloud agent provisioning, cloud-hybrid device bridge, local embeddings toggle, remote desktop gateway discovery over LAN/Tailscale, manual remote URL/token connect, gateway reconnect, and auth failure UX.
- Credential QA: `ELIZAOS_KEYSTORE_*`, `ANDROID_KEYSTORE_*` legacy secrets if kept, `PLAY_STORE_SERVICE_ACCOUNT_JSON`, Google/Firebase config if push notifications are expected, Eliza Cloud account/API credentials, gateway password/token, and any model download credentials.

## Changed paths

- `launchdocs/07-android-qa.md`

## AI QA Pass 2026-05-11 (static analysis)

Scope: Android-specific mobile-surface audit per `23-ai-qa-master-plan.md` Workstream 5.
No emulator/Cuttlefish available; this is a static read of the source tree on the
`worktree-agent-aba26969ab7dba910` branch off `develop`, plus a review of what the
simulator smoke harness actually asserts.

### Re-verification of prior P1 — preSeedAndroidLocalRuntimeIfFresh wiring

The 2026-05-10 `01-onboarding-setup-qa.md:76` P1 finding was that
`preSeedAndroidLocalRuntimeIfFresh()` was documented and tested but not actually
called from `packages/app/src/main.tsx`. **Status: RESOLVED.** Current code:

- Import at `packages/app/src/main.tsx:63`:
  `preSeedAndroidLocalRuntimeIfFresh,` (from `@elizaos/ui`).
- Call at `packages/app/src/main.tsx:255-257`:

  ```ts
  if (isElizaOS() && !hasRuntimePickerOverride()) {
    preSeedAndroidLocalRuntimeIfFresh();
  }
  ```

  This runs at top-level module scope, before `mountReactApp()` (called from
  `main()` at line 996). The gating is correct per the helper's contract — it only
  fires on the AOSP ElizaOS build (detected via the `ElizaOS/<tag>` user-agent
  suffix at `packages/ui/src/platform/init.ts:62-66`), and the `?runtime=picker`
  override at `:211-218` lets a user explicitly re-pick from the chooser.
- The helper definition at
  `packages/ui/src/onboarding/pre-seed-local-runtime.ts:112` exists and is tested.
- `RuntimeGate.tsx:770` comment still references `apps/app/src/main.tsx` (stale path
  — actual path is `packages/app/src/main.tsx`), but the contract holds.

Recommendation: still no static guard or integration test proving `main.tsx`
imports/calls the helper. A `grep` check in CI or a "main.tsx wires
preSeedAndroidLocalRuntimeIfFresh" unit test would prevent regression. This is the
Codex-fixable mitigation the original finding called for.

### Bugs/risks P0-P3 (this pass)

#### P0

- None found in this bounded static review.

#### P1

- **Android Activity is missing `windowSoftInputMode="adjustResize"` despite Capacitor
  Keyboard config declaring `resize: "body"`.** The MainActivity entry in
  `packages/app-core/platforms/android/app/src/main/AndroidManifest.xml:16-22` declares:

  ```xml
  <activity
      android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
      android:name=".MainActivity"
      android:label="@string/title_activity_main"
      android:theme="@style/AppTheme.NoActionBarLaunch"
      android:launchMode="singleTask"
      android:exported="true">
  ```

  No `android:windowSoftInputMode` attribute. `packages/app/capacitor.config.ts:26-29`
  configures the Capacitor Keyboard plugin with `resize: "body"` and
  `resizeOnFullScreen: true`, but Capacitor's `body` resize mode requires the
  underlying Activity to be in `adjustResize` mode. Android's default
  `adjustUnspecified` resolves to `adjustResize` for most layouts but is not
  guaranteed across OEMs (Samsung One UI, MIUI, EMUI). I did not find any code in
  `packages/app-core/scripts/run-mobile-build.mjs` that rewrites the activity tag to
  add `adjustResize`. Setting it explicitly is the documented Capacitor best
  practice and prevents OEM-specific keyboard-overlap regressions. Confidence: high.

- **Capacitor `Keyboard` plugin event listeners are only registered after platform
  init runs — there is a race with the React mount.**
  `packages/app/src/main.tsx:403-422` shows the keyboard listeners only register
  inside `initializeKeyboard()`, which `initializePlatform()` (`:359`) awaits AFTER
  `mountReactApp()` (`:996-997`). Between `mountReactApp()` resolving and
  `initializePlatform()` finishing, any input the user could focus would not have a
  `keyboardWillShow` listener installed, so `--keyboard-height` would stay 0 and
  the composer would not lift. In practice the keyboard takes a beat to appear, so
  this rarely manifests, but on a fast SSD-backed phone it can. Move
  `initializeKeyboard()` ahead of `mountReactApp()` or hoist the listeners to a
  pre-mount step. Confidence: medium.

#### P2

- **Phone / Messages / Contacts tab is shown on ALL Android builds, but the
  underlying Phone/Contacts overlay apps are gated on `isElizaOS()`.**
  `packages/ui/src/navigation/index.ts:115-129` defines
  `isAndroidPhoneSurfaceEnabled` as `isNative && platform === "android"`, which
  matches every Android Capacitor build, not just the ElizaOS AOSP build. But
  `packages/app/src/main.tsx:117-127` documents that the phone/contacts/wifi
  overlay apps register themselves only when `isElizaOS()` is true.
  `packages/ui/src/App.tsx:483-509` renders `PhonePageView`, `MessagesPageView`, and
  `ContactsPageView` when `androidPhoneSurfaceEnabled` is true. The components live
  in `packages/ui/src/components/pages/ElizaOsAppsView.tsx:297-1300` and they call
  into `getPlugins().contacts.plugin.listContacts(...)` (e.g.
  `ElizaOsAppsView.tsx:1199-1204`). On a vanilla Android Play Store APK (no
  ElizaOS user-agent suffix), those plugin entry points are unavailable, so
  `Contacts`/`Phone`/`Messages` will render with a hard error
  (`"ElizaContacts plugin is unavailable"`) rather than a graceful "not available
  on this device" state. Either gate `isAndroidPhoneSurfaceEnabled` to ElizaOS, or
  ship a clean unavailable state in those page views. Confidence: high.

- **Activity `configChanges` swallows orientation, screenSize, etc. with no Compose
  / React notification path.**
  `packages/app-core/platforms/android/app/src/main/AndroidManifest.xml:17`
  declares
  `android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"`.
  This is fine for Capacitor (no native config recreation), but it means orientation
  changes do NOT regenerate the Activity. The WebView still receives a CSS resize
  event, but if any React effect relies on Android Activity lifecycle to re-init
  (e.g. the StatusBar.setOverlaysWebView call at `packages/app/src/main.tsx:394-396`),
  it will not re-run on rotation. Re-verify rotation behavior on a tablet emulator.
  Confidence: medium.

- **Two mobile breakpoints disagree by 1 pixel.** Same as the iOS doc:
  `packages/ui/src/components/shell/Header.tsx:33` uses `(max-width: 819px)`;
  `packages/ui/src/App.tsx:78` defines `CHAT_MOBILE_BREAKPOINT_PX = 820`. Likely
  intentional; cross-platform finding worth resolving once.

- **GameViewOverlay has hardcoded `w-[480px]` without a responsive cap.** Same as
  iOS doc — applies to Android too at most phone widths.
  `packages/ui/src/components/apps/GameViewOverlay.tsx:158`. Confidence: high.

- **`AndroidManifest.xml` requests `ACCESS_BACKGROUND_LOCATION` but no rationale
  surfaces in the app today.**
  `packages/app-core/platforms/android/app/src/main/AndroidManifest.xml:80` declares
  `android.permission.ACCESS_BACKGROUND_LOCATION`. Play Console rejects apps that
  request `ACCESS_BACKGROUND_LOCATION` without an explicit background-location
  feature justification and Play Console form submission. If launch does not ship
  a real always-on location feature, drop this permission to avoid Play review
  friction. (Native location plugin
  `packages/native-plugins/location/android/src/main/AndroidManifest.xml:3` only
  declares `ACCESS_FINE_LOCATION` — so the background variant is only declared at
  the app level.) Confidence: medium-high.

- **Phone navigation route catalog has /phone, /messages, /contacts but only on
  Android.** `packages/ui/src/navigation/index.ts:291-322` (`TAB_PATHS`) registers
  routes for `phone`/`messages`/`contacts`. On iOS or web the user could deep-link
  to `/phone` via `tabFromPath` (line 395-456), which would map to the `phone` tab
  and then App.tsx `:486-509` would fall through to `<ChatView />` — fine. But the
  TabGroups builder at `:248-289` excludes the Phone tab on non-Android; the route
  still resolves. End state is "lands on phone tab silently rendering ChatView"
  which is acceptable but worth confirming with a Playwright probe on /phone
  /messages /contacts on the web build. Confidence: medium.

#### P3

- **`allowBackup="true"` in AndroidManifest can let backups include the on-device
  local-agent token.**
  `packages/app-core/platforms/android/app/src/main/AndroidManifest.xml:9` sets
  `android:allowBackup="true"`. The local-agent bearer token lives at
  `files/auth/local-agent-token` (per `mobile-local-chat-smoke.mjs:271` and
  `ElizaAgentService.java:623-669`). If Android Backup Service is enabled, those
  files could be backed up to Google Drive. Add `android:fullBackupContent` or
  `android:dataExtractionRules` to exclude the auth directory. Confidence: low-medium.

- **`isElizaOS()` detection relies entirely on user-agent suffix.**
  `packages/ui/src/platform/init.ts:62-66`. A non-Eliza Android app could spoof
  the user-agent and trigger the auto-local pre-seed path. Not a P1 because the
  spoof has no privilege gain (it just bypasses the runtime picker), but worth a
  note. Confidence: low.

- **WebView `webContentsDebuggingEnabled: false`** in
  `packages/app/capacitor.config.ts:70` is correct for release but blocks Chrome
  DevTools inspection. The mobile-local-chat-smoke harness has no equivalent
  debug-only path documented. If launch QA needs in-the-wild debugging, expose a
  build-mode flag. Confidence: low.

### What the simulator smoke (`mobile-local-chat-smoke.mjs`) actually asserts for Android

The harness at `packages/app/scripts/mobile-local-chat-smoke.mjs` does the
following for `--platform=android`:

1. **Discovers an Android device/emulator** via `adb devices` (`:164-177`). Fails
   with a clear error if `--require-installed`; otherwise warns.
2. **Checks the app is installed** via `adb shell pm path <appId>` (`:198`). Warns
   if missing.
3. **Launches the app** via
   `adb shell am start -n <appId>/.MainActivity` (`:207-211`) and fires the
   `elizaos://chat` deep link via `adb shell am start -a android.intent.action.VIEW
   -d elizaos://chat <appId>` (`:212-223`).
4. **Optionally taps through the Local-runtime first-run picker** (with
   `--android-select-local`, `:301-314`):
   - Reads physical screen size via `adb shell wm size`.
   - Taps the "I want to run it myself" tile at ratio (0.5, 0.695).
   - Loops up to 6 times tapping "Use Local" at ratio (0.29, 0.675) until the
     auth token file appears.
5. **Waits for the Android local-agent API to come up** (`:316-396`):
   - Reads `files/auth/local-agent-token` via `adb run-as cat`.
   - Forwards a random local port to device `tcp:31337` via `adb forward`.
   - Hits `/api/health` and `/api/status` with `Authorization: Bearer <token>` to
     prove the local agent is healthy.
   - Recovers if the token is rotated mid-test.
   - 240 attempts at 2s = up to 8 minutes total.
6. **Optionally runs the background-task harness** (with `--android-background`,
   `:546-706`):
   - Sends app to home screen via `adb shell input keyevent HOME`.
   - Waits for both `ElizaAgentService` and `GatewayConnectionService` to be
     `isForeground=true` via `adb shell dumpsys activity services <appId>`.
   - Finds the JobScheduler periodic job IDs via `adb shell dumpsys jobscheduler`.
   - Force-fires each job via `cmd jobscheduler run -f <appId> <jobId>`.
   - Polls `/api/health` for `lastWakeFiredAt` advance.
   - Falls back to `POST /api/background/run-due-tasks` on older builds.
   - Takes pre/post screenshots.
7. **Runs `runLocalInferenceApiSmoke`** against the forwarded loopback (`:1034`):
   - `GET /api/health`.
   - `POST /api/conversations` with `title: "Simulator local chat smoke"`.
   - `POST /api/conversations/<id>/greeting`.
   - Rejects if greeting contains `"I'm running locally"` (stale-string guard).
   - `POST /api/conversations/<id>/messages` with
     `{"text":"download the default local model"}`.
   - `GET /api/local-inference/hub` — accepts `ready` or any of
     `queued/downloading/verifying/complete` downloads. Rejects `error` state.
8. **Always** runs two Vitest specs at the end (`:1061-1072`):
   `packages/ui/src/api/ios-local-agent-kernel.local-inference.test.ts` and
   `packages/ui/src/onboarding/auto-download-recommended.test.ts`.

**Coverage gaps the smoke leaves:**

- The first-run picker tap-through (`--android-select-local`) uses hard-coded
  pixel ratios. Any redesign of the RuntimeGate picker breaks the smoke silently.
  Better: use accessibility selectors or a deterministic UI automator hook.
- The bottom nav is never tapped. No verification that each tab (chat / phone /
  apps / character / wallet / settings) resolves to its route.
- The Phone / Messages / Contacts tab gating (the P2 finding above) is not
  exercised — and on a vanilla Android emulator without the ElizaOS marker, the
  smoke would hit the broken state described in that finding.
- Safe-area insets are not asserted. Screenshots are full-screen but never diffed
  against a reference.
- Keyboard handling is not exercised — no input focus, no `--keyboard-height`
  assertion.
- `windowSoftInputMode` (P1 finding) is not verifiable from the smoke; needs a
  physical emulator probe focusing a composer and inspecting WebView resize.
- The background-runner harness force-fires JobScheduler periodic jobs but does
  NOT prove the BackgroundRunner Capacitor plugin label (`eliza-tasks` per
  `capacitor.config.ts:38`) is the JobScheduler job — it discovers job IDs by
  package and assumes any periodic job for the package is the right one.
- `ACCESS_BACKGROUND_LOCATION` (P2 finding above) is never exercised, so Play
  Console rejection risk is not surfaced by smoke.
- AOSP-specific paths (`AOSP_BUILD=true` Gradle property, system-app install,
  default-roles assignment from `packages/os/android/vendor/eliza/...`) are not
  reachable from this smoke at all — they require a Cuttlefish run.

### Severity counts (this pass)

- P0: 0
- P1: 2 (`windowSoftInputMode` missing; keyboard-listener race with React mount)
- P2: 6 (Phone tab on vanilla Android; configChanges rotation; breakpoint off-by-one;
  GameViewOverlay width; `ACCESS_BACKGROUND_LOCATION`; phone routes on non-Android)
- P3: 3 (`allowBackup` true; UA-based ElizaOS detection; debug-disabled in dev too)

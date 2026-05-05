# Launch Readiness 07: Android Build And QA

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

# Launch Readiness 06: iOS Build And QA

## Second-Pass Status (2026-05-05)

- Superseded: `CapacitorApp` and `CapacitorPreferences` are present in the current Podfile and generated Podfile tests; their absence from SPM is intentional for incompatible plugins.
- Still open: iOS Agent remains a native stub, runtime docs reference missing helper commands/env vars, and cloud remote-session consume/activate is not implemented.
- Launch gate: static mobile artifact checks pass, but physical iPhone, TestFlight/App Store, APNs, permissions, and cloud-hybrid device bridge validation remain manual/live.

## Current state

The active mobile host app is `packages/app`, with Capacitor 8.3.1 dependencies and scripts for `build:ios`, `ios`, `cap:sync:ios`, and `cap:open:ios` in `packages/app/package.json:5-28`. The root `package.json` does not expose iOS-specific scripts.

The canonical native iOS template lives under `packages/app-core/platforms/ios`; the generated app tree also exists under `packages/app/ios`. A read-only readiness check reports both `packages/app/ios` and `packages/app/android` as Capacitor-ready. I did not run `cap sync`, `pod install`, or a native build because those mutate generated native files and can be long-running.

`packages/app/capacitor.config.ts:4-50` configures the native shell with `webDir: "dist"`, HTTPS schemes, broad allow-navigation entries for local/cloud/game hosts, `CapacitorHttp.enabled = true`, and iOS mobile content mode. The app identity comes from `packages/app/app.config.ts:21-35`.

iOS runtime config supports `remote-mac`, `cloud`, `cloud-hybrid`, and `local` as a type shape in `packages/app/src/ios-runtime.ts:1-95`. The app shell starts the mobile DeviceBridge client for `cloud-hybrid` or `local` modes in `packages/app/src/main.tsx:773-804`. The native iOS Agent plugin is intentionally a stub, so iOS is currently a remote/cloud shell, not a full local iOS agent (`packages/native-plugins/agent/ios/Sources/AgentPlugin/AgentPlugin.swift:3-12`).

Remote desktop support is split. Legacy local desktop sessions can use Tailscale/ngrok/VNC through `plugins/app-lifeops/src/lifeops/remote-desktop.ts:175-201` and `plugins/app-lifeops/src/lifeops/remote-desktop.ts:383-508`. The newer remote-session control plane has local service actions and cloud DB endpoints, but I did not find an end-to-end cloud pairing consume/activate path.

## Evidence reviewed with file refs

- iOS scripts and Capacitor deps: `packages/app/package.json:5-94`, `package.json:9-92`.
- Capacitor config and app identity: `packages/app/capacitor.config.ts:4-50`, `packages/app/app.config.ts:21-55`.
- Mobile build orchestration: `packages/app-core/scripts/run-mobile-build.mjs:1320-1511`, `packages/app-core/scripts/run-mobile-build.mjs:1743-1977`.
- Platform template sync/readiness: `packages/app-core/scripts/lib/capacitor-platform-templates.mjs:1-228`.
- iOS template/native app files: `packages/app-core/platforms/ios/App/Podfile:1-50`, `packages/app-core/platforms/ios/App/App/Info.plist`, `packages/app-core/platforms/ios/fastlane/Fastfile:16-92`.
- Generated iOS app tree: `packages/app/ios/App/Podfile:1-32`, `packages/app/ios/App/CapApp-SPM/Package.swift:13-34`, `packages/app/ios/App/Podfile.lock`.
- iOS runtime/device bridge: `packages/app/src/ios-runtime.ts:1-95`, `packages/app/src/main.tsx:744-821`, `packages/app/test/ios-runtime.test.ts:1-64`.
- Mobile runtime UX: `packages/app-core/src/onboarding/mobile-runtime-mode.ts:4-85`, `packages/app-core/src/components/shell/RuntimeGate.tsx` refs found by search.
- Local inference/DeviceBridge refs: `packages/native-plugins/llama/src/index.ts:1-23`, `packages/app-core/src/runtime/mobile-local-inference-gate.test.ts`.
- Remote session/control-plane refs: `plugins/app-lifeops/src/actions/start-remote-session.ts:1-201`, `plugins/app-lifeops/src/actions/remote-desktop.ts:54-254`, `plugins/app-lifeops/src/remote/remote-session-service.ts:1-242`, `cloud/apps/api/v1/remote/pair/route.ts:1-103`, `cloud/apps/api/v1/remote/sessions/route.ts:1-55`, `cloud/packages/db/repositories/remote-sessions.ts:14-63`.

## What I could validate

- App shell TypeScript passes `tsc --noEmit`.
- iOS runtime config tests pass, including cloud-hybrid DeviceBridge URL derivation.
- Mobile runtime-mode and mobile local-inference gate tests pass.
- Remote session service, remote desktop action, and Tailscale transport unit tests pass.
- `run-mobile-build.mjs` and `packages/app/scripts/build.mjs` pass Node syntax checks.
- iOS template plist/entitlement/privacy/export plist files all pass `plutil -lint`.
- Template Podfile passes `ruby -c`.
- Xcode is installed (`26.4.1`) and lists `App` plus `WebsiteBlockerContentExtension` targets/schemes from the iOS project.
- CocoaPods is installed (`1.16.2`).
- `resolveIosBuildTarget()` chooses `iphoneos` because `llama-cpp-capacitor` ships an arm64 device framework; `lipo` confirms that framework is arm64-only.

## What I could not validate

- Full `bun run --cwd packages/app build:ios`, `cap sync ios`, `pod install`, or `xcodebuild build`.
- Physical iPhone install, simulator behavior, TestFlight, App Store upload, or App Review metadata.
- Real iOS permissions: Local Network/Bonjour, microphone, camera, speech recognition, HealthKit, background fetch, Family Controls, app groups, WebsiteBlocker extension, APNs.
- Real cloud login, remote Mac connection over LAN/WAN, cloud-hybrid local inference on device, Tailscale/ngrok/VNC data plane, or remote cloud-agent pairing.
- Apple Developer credentials, match certificates repo access, provisioning profiles, App Store Connect app id, APNs entitlement, HealthKit/Family Controls approval.

## Build/test commands attempted/results

- `bun run --cwd packages/app test -- test/ios-runtime.test.ts` - passed, 1 file / 6 tests.
- `bun run --cwd packages/app-core test -- test/onboarding/mobile-runtime-mode.test.ts src/runtime/mobile-local-inference-gate.test.ts` - passed, 2 files / 13 tests.
- `bun run --cwd plugins/app-lifeops test -- test/remote-session-service.test.ts test/remote-desktop-action.test.ts` - passed, 2 files / 21 tests.
- `bun run --cwd plugins/app-lifeops test -- src/remote/tailscale-transport.test.ts` - passed, 1 file / 15 tests.
- `bun run --cwd packages/app typecheck` - passed.
- `node --check packages/app-core/scripts/run-mobile-build.mjs` - passed.
- `node --check packages/app/scripts/build.mjs` - passed.
- `ruby -c packages/app-core/platforms/ios/App/Podfile` - `Syntax OK`.
- `plutil -lint ...` on iOS template plists/entitlements/privacy files - all OK.
- `xcodebuild -version` - Xcode 26.4.1.
- `xcodebuild -list -project packages/app-core/platforms/ios/App/App.xcodeproj` - listed `App` and `WebsiteBlockerContentExtension`.

## Bugs/risks P0-P3

### P0

- None found in bounded checks.

### P1

- Superseded: the Podfile gap is fixed. Current `packages/app/ios/App/Podfile` includes `CapacitorApp` and `CapacitorPreferences`, and `packages/app-core/scripts/run-mobile-build.test.ts` covers generated Podfile output. `CapApp-SPM/Package.swift` still omits those plugins because SPM-incompatible plugins are stripped intentionally; CocoaPods is the source of truth for them.
- Remote-to-cloud-agent support appears incomplete. The cloud pair endpoint creates a pending DB row and code hash (`cloud/apps/api/v1/remote/pair/route.ts:72-97`), but the repository only has create/find/list/revoke (`cloud/packages/db/repositories/remote-sessions.ts:14-63`), and the agent action consumes a local `PairingCodeStore` instead (`plugins/app-lifeops/src/actions/start-remote-session.ts:129-136`). I did not find a cloud consume/activate/update-ingress path.

### P2

- The iOS runtime-mode docs reference missing helper commands and env vars. `docs/apps/mobile/build-guide.md:75-104` documents `bun run dev:ios:*`, `ELIZA_IOS_REMOTE_API_BASE`, and `ELIZA_IOS_DEVICE_BRIDGE_API_BASE`; current `packages/app/package.json:5-28` has no `dev:ios:*`, and `packages/app/src/ios-runtime.ts:60-95` reads `VITE_ELIZA_IOS_API_BASE`, `VITE_ELIZA_IOS_API_TOKEN`, and `VITE_ELIZA_DEVICE_BRIDGE_URL/TOKEN`.
- The cloud/local model UX is code-shaped but not device-validated. `cloud-hybrid` starts the DeviceBridge client, and tests cover URL derivation, but actual iOS local inference depends on an arm64-only `llama-cpp-capacitor` framework and a real paired agent/device path.
- The remote desktop stack has two partially overlapping paths: legacy `REMOTE_DESKTOP` returns Tailscale/ngrok/VNC session URLs, while `START_REMOTE_SESSION` returns service-backed authorization with `ingressUrl: null` when no data plane is configured (`plugins/app-lifeops/src/actions/start-remote-session.ts:151-175`). Product QA must choose which path is launch-blocking.

### P3

- Mobile docs still say `apps/app` in places, but the actual host is `packages/app` (`docs/apps/mobile/build-guide.md:7-9`, `packages/app/package.json:2`).
- `packages/app/src/ios-runtime.ts:60-77` duplicates some ELIZA env keys in the read arrays and does not use the branded alias support present in `packages/app-core/src/platform/ios-runtime.ts:63-88`.
- `packages/app-core/scripts/run-mobile-build.mjs:281-282` repeats `ELIZA_IOS_DEVELOPMENT_TEAM`, likely intended to check a branded/team alias.

## Codex-fixable work

- Keep the Podfile/template regression test in the launch gate so `CapacitorApp`, `CapacitorPreferences`, and future official plugin imports cannot drift again.
- Either restore `scripts/ios-runtime-mode.mjs` plus `dev:ios:*` scripts, or update the build guide to the current `VITE_*` env flow.
- Wire branded iOS runtime env aliases consistently between `packages/app/src/ios-runtime.ts` and app-core.
- Add cloud remote-session consume/activate/update-ingress repository methods and routes, then make `START_REMOTE_SESSION` able to consume cloud-issued pairing codes.
- Add a no-native-build CI check that lints plist/Podfile, validates Capacitor platform readiness, and asserts docs/scripts do not drift.

## Human/device/App Store/credential QA needed

- Run `bun run --cwd packages/app build:ios` on a clean branch, then inspect any generated diffs before committing native outputs.
- Install on a physical iPhone and test: cloud onboarding, remote Mac onboarding, cloud-hybrid phone compute, app lifecycle resume/pause, deep links, Preferences persistence, local network discovery, and DeviceBridge reconnect.
- Exercise microphone, camera, speech recognition, HealthKit, Family Controls, WebsiteBlocker extension, background fetch, APNs, and Local Network prompts.
- Validate Tailscale/ngrok/VNC remote desktop from phone to desktop, plus cloud-agent pairing/list/revoke once the cloud consume path exists.
- Confirm Apple Developer team, bundle ids, app group ids, extension bundle id, provisioning profiles, match repo access, App Store Connect app id, privacy policy/support URLs, export compliance, and TestFlight upload.

## Changed paths

- `launchdocs/06-ios-qa.md`

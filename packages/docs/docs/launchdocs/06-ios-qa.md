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

## AI QA Pass 2026-05-11 (static analysis)

Scope: iOS-specific mobile-surface audit per `23-ai-qa-master-plan.md` Workstream 5. No
physical iPhone available; this is a static read of the source tree on the
`worktree-agent-aba26969ab7dba910` branch off `develop`, plus a review of what the
simulator smoke harness actually asserts.

### Re-verification of prior P1 — preSeedAndroidLocalRuntimeIfFresh wiring

The 2026-05-10 `01-onboarding-setup-qa.md:76` P1 finding was that
`preSeedAndroidLocalRuntimeIfFresh()` was documented and tested but not actually called
from `packages/app/src/main.tsx`. **Status: RESOLVED.** The helper is now imported at
`packages/app/src/main.tsx:63` and invoked at top-level (before `mountReactApp()` /
`main()`) at `packages/app/src/main.tsx:255-257`, gated on
`isElizaOS() && !hasRuntimePickerOverride()`. This change is iOS-irrelevant (helper is
Android-only), but documenting the resolution here for cross-reference with the Android doc.

### Bugs/risks P0-P3 (this pass)

#### P0

- None found in this bounded static review.

#### P1

- **BGTaskScheduler identifier mismatch between simulator smoke and Info.plist.**
  `packages/app/scripts/mobile-local-chat-smoke.mjs:28` and `:728` default the iOS
  background-task identifier to `ai.eliza.tasks.refresh`, and the LLDB
  `_simulateLaunchForTaskWithIdentifier:` invocation at
  `packages/app/scripts/mobile-local-chat-smoke.mjs:793` fires that exact id.
  `packages/app-core/platforms/ios/App/App/Info.plist:94-97` only declares one permitted
  identifier — `eliza-tasks` — which is also the `BackgroundRunner` plugin label at
  `packages/app/capacitor.config.ts:37-44`. Result: the `--ios-background` smoke path
  cannot actually fire the background task on a real build; iOS silently rejects task
  identifiers not in `BGTaskSchedulerPermittedIdentifiers`. The harness currently
  swallows this because `lastWakeFiredAt` is not yet wired (Wave 3D pending), so it
  emits the "wake-field-not-implemented" warning and returns `ok: true`
  (`packages/app/scripts/mobile-local-chat-smoke.mjs:843-862`). When Wave 3D lands, the
  smoke will start passing falsely or failing for the wrong reason. Fix is one of:
  rename `eliza-tasks` to `ai.eliza.tasks.refresh` in Info.plist and BackgroundRunner
  config; or change the smoke harness default to `eliza-tasks`. Confidence: high.

#### P2

- **iOS Keyboard.setResizeMode mode = "None" while Capacitor config says
  `resize: "body"`.** `packages/app/src/main.tsx:404-408` sets
  `Keyboard.setResizeMode({ mode: KeyboardResize.None })` and disables auto-scroll, while
  `packages/app/capacitor.config.ts:26-29` declares
  `Keyboard: { resize: "body", resizeOnFullScreen: true }`. The runtime call wins, so iOS
  ends up in `None` mode where the app must use `--keyboard-height` from the
  `keyboardWillShow` listener (`packages/app/src/main.tsx:410-421`) to manually offset
  the chat composer. The chat composer at
  `packages/ui/src/components/composites/chat/chat-composer-shell.tsx:47` and
  `packages/ui/src/components/pages/ChatView.tsx:621` does honor
  `--keyboard-height`, but other input surfaces (Settings, Connectors, RuntimeGate
  manual remote URL, login/pair, etc.) do NOT — they rely on the WebView resizing
  itself. With `resize: "None"`, the keyboard will cover the bottom of those forms
  on iOS. The config-vs-runtime mismatch is also a maintainability hazard: future
  contributors will reasonably assume `resize: "body"` is in effect. Confidence: medium-high.

- **GameViewOverlay floating window has hardcoded `w-[480px]` with no responsive
  cap.** `packages/ui/src/components/apps/GameViewOverlay.tsx:158` declares
  `className="absolute w-[480px] h-[360px] ..."`. On iPhone SE (320px) and iPhone 13 mini
  (375px) this overlay overflows the viewport. The element has `resize: "both"` so the
  user can shrink it, but the default opening position is `right: 16, bottom: 16`
  (line 152), which forces a 480px-wide window into a 320–390px viewport. Confidence: high.

- **Two mobile breakpoints disagree by 1 pixel.** `packages/ui/src/components/shell/Header.tsx:33`
  uses `(max-width: 819px)` for the bottom-nav swap; `packages/ui/src/App.tsx:78` defines
  `CHAT_MOBILE_BREAKPOINT_PX = 820`. At exactly 820px the header is still desktop but
  the chat is mobile. Likely intentional but undocumented; confirm by viewport probe at
  819/820/821 widths or unify. Confidence: medium.

- **iOS local mode renders a "device bridge" that is intentionally null, but the
  comment-driven contract relies on the comment not the code.**
  `packages/app/src/main.tsx:813-835` returns `null` from `resolveDeviceBridgeUrl` for
  `config.mode === "local" && isIOS` with a comment saying
  "requests are handled by the in-process ITTP route kernel, so a loopback WebSocket
  bridge is both unnecessary and unsafe in simulator runs". `initializeMobileDeviceBridge`
  at `packages/app/src/main.tsx:896-940` then early-returns on `agentUrl === null`. This
  works, but there is no logging telling the developer the bridge is intentionally
  skipped, and the BackgroundRunner.dispatchEvent call at `:875-880` still adds
  `localRouteKernel: "ittp"` to the details payload regardless. If a future change
  silently sets `agentUrl` for iOS local, the bridge would attempt to start against a
  non-existent loopback. Add a one-line `console.info` when the iOS-local skip fires,
  and/or a static check. Confidence: medium.

#### P3

- **Stale "I'm running locally" greeting check in smoke is a guard against a fix that
  already landed.** `packages/app/scripts/mobile-local-chat-smoke.mjs:956-958` rejects
  if a greeting contains "I'm running locally". The current
  `runLocalInferenceApiSmoke` path doesn't reference any greeting source. This is a
  regression guard, not a finding, but worth a note: if it ever fires, it likely means
  someone re-introduced the stale copy from an older onboarding revision. Confidence: low.

- **`UISupportedInterfaceOrientations` allows landscape on iPhone.** `Info.plist:73-78`
  permits Portrait + LandscapeLeft + LandscapeRight on iPhone. The mobile shell layout
  (bottom-nav at the bottom of the viewport, sticky header at the top, fixed mobile
  chat 3-surface layout in `packages/ui/src/App.tsx:752-806`) has not been audited at
  landscape iPhone widths (e.g. 844×390). No P0/P1 emerges, but a landscape iPhone
  pass should be on the simulator QA checklist. Confidence: low.

- **Camera/HealthKit/Calendar usage strings claim user-driven access only, but the
  microphone string mentions "voice wake" which implies background or
  always-listening microphone access.** `Info.plist:117-118`: "This app needs
  microphone access for voice wake, talk mode, and video capture." If launch QA does
  not actually ship background voice wake, the App Store review team can ask
  legitimate questions. Cross-check with the store-review notes
  (`22-store-review-notes.md`). Confidence: low.

- **Capacitor `iosScheme: "https"` plus broad `allowNavigation` matrix.**
  `packages/app/capacitor.config.ts:9-23` lists `*.elizacloud.ai`, `app.eliza.how`,
  `cloud.eliza.how`, `*.eliza.how`, `rs-sdk-demo.fly.dev`, `*.fly.dev`,
  `hyperscape.gg`, `*.hyperscape.gg`. The `*.fly.dev` wildcard is noteworthy because
  any Fly.io tenant could match. Verify against `22-store-review-notes.md` whether
  this matches what the data-safety form claims. Confidence: low.

### What the simulator smoke (`mobile-local-chat-smoke.mjs`) actually asserts for iOS

The harness at `packages/app/scripts/mobile-local-chat-smoke.mjs` does the following
for `--platform=ios`:

1. **Discovers a booted iOS simulator** via `xcrun simctl list devices booted`
   (`:126-132`). Returns null if none; logs a warning.
2. **Checks the app is installed** via `xcrun simctl get_app_container <udid> <appId> app`
   (`:142-154`). If missing and `--require-installed` is not set, only warns.
3. **Launches the app** via `xcrun simctl launch` (`:159`) and opens the
   `elizaos://chat` deep link via `xcrun simctl openurl` (`:160`).
4. **Optionally runs the BG-task harness** (only with `--ios-background`,
   `:1038-1059`):
   a. Re-opens `elizaos://chat` (`:744`).
   b. Reads `/api/health` from `http://127.0.0.1:31337` to capture
      `lastWakeFiredAt` baseline (`:752-767`). On the simulator there is NO adb-style
      port forwarding, so this call almost always fails today — and the harness
      treats failure as "wake-field-not-implemented" (`:843-862`).
   c. Resolves the app PID via `xcrun simctl spawn <udid> launchctl print ...`
      (`:770-779`).
   d. Attaches `xcrun simctl spawn <udid> lldb -p <pid>` and runs
      `expr (void)[[BGTaskScheduler sharedScheduler]
      _simulateLaunchForTaskWithIdentifier:@"ai.eliza.tasks.refresh"]` (`:791-812`).
      This is the P1 finding above — identifier is not declared in Info.plist.
   e. Polls `/api/health` for `lastWakeFiredAt` advance (`:822-835`).
   f. Takes pre/post screenshots via `xcrun simctl io screenshot`.
5. **If `--api-base` is supplied**, runs `runLocalInferenceApiSmoke` against that
   base — creates a conversation, fetches greeting, sends one message, reads
   `/api/local-inference/hub` (`:927-1003`). Note: this path is invoked when
   `apiBase` is set on the command line, not derived from the running iOS simulator
   (there is no iOS equivalent of the Android adb-forward block at `:316-396`).
6. **Always** runs two Vitest specs at the end:
   `packages/ui/src/api/ios-local-agent-kernel.local-inference.test.ts` and
   `packages/ui/src/onboarding/auto-download-recommended.test.ts` (`:1061-1072`).

**Coverage gaps the smoke leaves:**

- No bottom-nav tap probe (the harness never taps the iOS UI). Coverage of bottom-nav
  routes (chat / apps / character / wallet / settings) is zero from this harness.
- No keyboard-handling probe. The harness does not focus an input or assert
  `--keyboard-height` updates.
- No safe-area assertion. Captures full-screen PNGs but never checks that content
  respects the notch / home indicator inset.
- No `/phone`, `/messages`, `/contacts` probe — and on iOS these correctly fall through
  to `<ChatView />` per `packages/ui/src/App.tsx:486-509` because
  `androidPhoneSurfaceEnabled` is `false`; but the harness does not verify that.
- No iOS-local device-bridge path verification. On iOS local mode `resolveDeviceBridgeUrl`
  returns `null` (`packages/app/src/main.tsx:823`) and the in-process ITTP route kernel
  takes over; the harness does not exercise that kernel from a webview-style call.
- No verification that `--keyboard-height` toggles `keyboard-open` class. Listeners at
  `packages/app/src/main.tsx:410-421` are unverified end-to-end.
- No safe-area-inset verification under landscape orientation (which iPhone Info.plist
  permits, see P3 above).
- The BG-task harness fires an identifier (`ai.eliza.tasks.refresh`) not declared in
  Info.plist — see P1 above.

### Severity counts (this pass)

- P0: 0
- P1: 1 (BGTask identifier mismatch)
- P2: 4 (Keyboard.None vs config "body"; GameViewOverlay hardcoded width; breakpoint
  off-by-one; iOS local-bridge skip is undocumented at runtime)
- P3: 4 (stale greeting guard; landscape orientation unaudited; microphone usage string;
  broad `allowNavigation`)

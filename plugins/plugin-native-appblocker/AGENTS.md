# @elizaos/capacitor-appblocker

Capacitor plugin that blocks selected apps on Android (Usage Access + system overlay) and iOS (Family Controls + ManagedSettings).

## Purpose / role

This is a Capacitor native plugin — not an elizaOS action/service plugin. It exposes a JavaScript API (`AppBlocker`) that a Capacitor-based Eliza agent app can call to check permissions, let the user select apps to block, apply a block, and remove it. It has no runtime on the web: `checkPermissions`/`requestPermissions` return `status: "not-applicable"`, `getStatus` returns `status: "unavailable"`, `blockApps`/`unblockApps` return `success: false`, and `getInstalledApps`/`selectApps` return empty results. It is opt-in: the consuming app must register `ElizaAppBlockerPlugin` with Capacitor and call into the JS API.

## Plugin surface

This is a Capacitor plugin, not an elizaOS plugin. It does not register elizaOS actions, providers, services, evaluators, routes, or events. The JS-side API exported from `src/index.ts` is:

| Method | Description |
|---|---|
| `AppBlocker.checkPermissions()` | Returns current permission status and engine capabilities |
| `AppBlocker.requestPermissions()` | Opens system settings to grant Usage Access + overlay (Android) or triggers Family Controls auth (iOS) |
| `AppBlocker.getInstalledApps()` | Returns list of installed launcher apps (Android only; iOS returns `[]`) |
| `AppBlocker.selectApps()` | iOS: opens `FamilyActivityPicker` and returns selected apps with `tokenData`. Android: returns `{ apps: [], cancelled: true }` (no picker UI on Android — use `getInstalledApps` to build your own list) |
| `AppBlocker.blockApps(options)` | Activates blocking for given `packageNames` (Android) or `appTokens` (iOS); optional `durationMinutes` |
| `AppBlocker.unblockApps()` | Removes all active blocks |
| `AppBlocker.getStatus()` | Returns full `AppBlockerStatus` including active state, blocked count, engine, and permission details |

`src/backend.ts` exports `NativeAppBlockerBackend` (interface) and `createNativeAppBlockerBackend(plugin)` (factory). Pass the registered `AppBlocker` Capacitor plugin to get an adapter shaped for `@elizaos/plugin-blocker`'s `registerNativeAppBlockerBackend()`. This is the integration seam between the Capacitor native layer and the elizaOS blocker engine.

## Layout

```
plugins/plugin-native-appblocker/
  src/
    index.ts               JS entry — registerPlugin("ElizaAppBlocker") + lazy web fallback
    definitions.ts         All TypeScript types: AppBlockerPlugin, AppBlockerStatus,
                           BlockAppsOptions, InstalledApp, SelectAppsResult, etc.
    web.ts                 Web fallback — all methods return not-applicable/unavailable
    web.test.ts            Vitest tests for web fallback contracts
    backend.ts             Backend adapter — wraps AppBlockerPlugin as NativeAppBlockerBackend
                           for registerNativeAppBlockerBackend() in @elizaos/plugin-blocker
    backend.test.ts        Vitest tests for the backend adapter
  android/src/main/
    AndroidManifest.xml    Declares permissions (PACKAGE_USAGE_STATS, SYSTEM_ALERT_WINDOW,
                           FOREGROUND_SERVICE, POST_NOTIFICATIONS) and ForegroundService
    java/ai/eliza/plugins/appblocker/
      AppBlockerPlugin.kt        Capacitor @PluginMethod handlers for Android
      AppBlockerForegroundService.kt  Polls UsageStatsManager every 500 ms; shows/hides overlay
      AppBlockerStateStore.kt    SharedPreferences persistence for blocked packages + expiry
  ios/Sources/AppBlockerPlugin/
    AppBlockerPlugin.swift       CAPPlugin with all method handlers for iOS
    AppBlockerShared.swift       ManagedSettingsStore shield apply/clear + UserDefaults state
    FamilyActivityPickerBridge.swift  SwiftUI FamilyActivityPicker presented as form sheet
  ElizaosCapacitorAppblocker.podspec  CocoaPods spec (links FamilyControls + ManagedSettings)
  rollup.config.mjs          Bundles dist/esm → dist/plugin.js (IIFE) + dist/plugin.cjs.js
  tsconfig.json              ES2022, strict, noImplicitAny, noUnusedLocals/Parameters
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-appblocker clean           # remove build output
bun run --cwd plugins/plugin-native-appblocker build           # build package artifacts
bun run --cwd plugins/plugin-native-appblocker typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-appblocker lint            # mutating Biome check
bun run --cwd plugins/plugin-native-appblocker lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-appblocker format          # write formatting
bun run --cwd plugins/plugin-native-appblocker format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-appblocker test            # run package tests
bun run --cwd plugins/plugin-native-appblocker prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-appblocker build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / env vars

This plugin reads no environment variables. It requires OS-level permissions granted at runtime by the user:

- **Android**: `PACKAGE_USAGE_STATS` (Usage Access) and `SYSTEM_ALERT_WINDOW` (Draw Over Other Apps) — must both be granted for `blockApps` to succeed.
- **iOS**: Family Controls authorization (`AuthorizationCenter.shared.requestAuthorization`) — requires a developer provisioning profile with `com.apple.developer.family-controls` entitlement. Timed blocks (`durationMinutes > 0`) require a DeviceActivity extension and return an explicit unsupported-capability error in this package.

## How to extend

**Add a new method (JS → native):**

1. Add the method signature to `AppBlockerPlugin` interface in `src/definitions.ts`.
2. Add an unavailable/error implementation in `src/web.ts` (`AppBlockerWeb`).
3. Add `@PluginMethod fun myMethod(call: PluginCall)` to `android/.../AppBlockerPlugin.kt`.
4. Add `@objc func myMethod(_ call: CAPPluginCall)` to `ios/.../AppBlockerPlugin.swift` and register it in `pluginMethods`.
5. Run `bun run --cwd plugins/plugin-native-appblocker build` to rebuild `dist/`.

## Conventions / gotchas

- **Instrumented test (issue #9967).** The launchable-app enumeration (`PackageManager.queryIntentActivities(MAIN/LAUNCHER)`) lives in `InstalledAppsReader`; `getInstalledApps` delegates to it (JS shape unchanged) so an on-device `androidTest` drives the real `PackageManager` (permission-free positive read). Complements the `AppBlockerStateStore` block-state device test.
- **Capacitor plugin, not elizaOS plugin**: this has no `Plugin` object shaped for `AgentRuntime`. Do not wire it into elizaOS plugin loading. The consuming app imports and uses `AppBlocker` from JS.
- **Android blocking engine**: a foreground service (`AppBlockerForegroundService`) polls `UsageStatsManager.queryEvents` every 500 ms and shows a full-screen system overlay when a blocked app moves to foreground. The service is `START_STICKY`; it self-terminates if the block state is cleared or the timer expires.
- **iOS engine**: uses `ManagedSettingsStore` to set `store.shield.applications`. No polling; the OS enforces the shield. `getInstalledApps` always returns `[]` on iOS because Family Controls does not expose an app list — use `selectApps` to let the user pick via `FamilyActivityPicker`.
- **iOS timed blocks**: require a DeviceActivity extension. `blockApps` with `durationMinutes > 0` returns `success: false` with an explanatory unsupported-capability error. An indefinite block + manual `unblockApps` is the current iOS path.
- **Build output**: `tsc` writes to `dist/esm/`; rollup bundles that into `dist/plugin.js` (IIFE for CDN/`unpkg`) and `dist/plugin.cjs.js` (CJS for Node consumers). The `exports` field in `package.json` points directly to `src/index.ts` for Bun/development consumers.
- **Capacitor version**: peer dep `@capacitor/core ^8.3.1`. Keep in sync with the consuming app's Capacitor version or Capacitor's JS ↔ native bridge will misroute calls.
- **iOS deployment target**: iOS 15.0 (set in podspec). `FamilyControls` authorization API differs between iOS < 16 and >= 16; `AppBlockerPlugin.swift` handles both paths.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->

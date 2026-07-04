# @elizaos/capacitor-mobile-signals

Capacitor plugin that bridges mobile wake, lock, battery, and protected-data state into Eliza agents via the `MobileSignals` Capacitor plugin interface.

## Purpose / role

This is a **Capacitor plugin** (not an elizaOS runtime plugin with actions/providers). It exposes a cross-platform `MobileSignals` API surface that an Eliza mobile app (iOS or Android) installs and calls. On iOS it uses HealthKit, FamilyControls, and DeviceActivity; on Android it uses Health Connect and `PACKAGE_USAGE_STATS`. A web fallback uses `document.visibilityState`, `window.focus/blur`, and the Battery Status API. The plugin is opt-in — it must be explicitly registered with the Capacitor app and its native permissions must be granted by the user.

## Plugin surface

This package registers one Capacitor plugin: **`MobileSignals`**.

| Method | Description |
|---|---|
| `checkPermissions()` | Returns current permission status, capabilities, screen-time status, and required setup actions. |
| `requestPermissions(options?)` | Triggers native permission request flows (health, screen time, notifications). |
| `openSettings(options?)` | Opens a specific native settings page (app, health, battery optimization, etc.). |
| `startMonitoring(options?)` | Starts event streaming; returns initial device + health snapshots. |
| `stopMonitoring()` | Stops event streaming and removes all native listeners. |
| `getSnapshot()` | One-shot async read of current device + health state without streaming. |
| `scheduleBackgroundRefresh()` | Background refresh is unavailable on the current native implementations (iOS uses foreground monitoring and routes background work elsewhere; web cannot schedule). Always resolves `scheduled: false` with a reason. |
| `cancelBackgroundRefresh()` | No native background-refresh task is registered to cancel. Always resolves `cancelled: false` with a reason. |
| `addListener("signal", fn)` | Subscribes to `MobileSignalsSignal` events (device snapshot or health snapshot). |
| `removeAllListeners()` | Removes all registered event listeners. |

Two snapshot types are emitted on `"signal"`:
- **`MobileSignalsSnapshot`** (`source: "mobile_device"`) — state, idle/locked status, battery.
- **`MobileSignalsHealthSnapshot`** (`source: "mobile_health"`) — sleep, biometrics, screen-time status.

## Layout

```
src/
  definitions.ts   All exported TypeScript types and the MobileSignalsPlugin interface
  index.ts         Capacitor registerPlugin call — entry point for the JS/TS consumer
  web.ts           MobileSignalsWeb: browser fallback using visibility, focus, Battery API

android/
  src/main/java/ai/eliza/plugins/mobilesignals/
    MobileSignalsPlugin.kt   Android Capacitor plugin implementation

ios/Sources/MobileSignalsPlugin/
  MobileSignalsPlugin.swift  iOS Capacitor plugin implementation (HealthKit, FamilyControls)
  ScreenTimeSupport.swift    iOS Screen Time / DeviceActivity helpers

scripts/
  validate-ios-screen-time.mjs        Build-time wiring validator (exports validateIosScreenTimeBuildWiring, assertIosScreenTimeBuildWiring)
  validate-ios-screen-time.test.mjs   Tests for the validator

ElizaosCapacitorMobileSignals.podspec  CocoaPods spec (links FamilyControls + DeviceActivity frameworks)
rollup.config.mjs                      Rollup config for CJS bundle
tsconfig.json                          TypeScript config (emits to dist/esm/)
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-mobile-signals clean                     # remove build output
bun run --cwd plugins/plugin-native-mobile-signals build                     # build package artifacts
bun run --cwd plugins/plugin-native-mobile-signals typecheck                 # TypeScript typecheck
bun run --cwd plugins/plugin-native-mobile-signals lint                      # mutating Biome check
bun run --cwd plugins/plugin-native-mobile-signals lint:check                # read-only Biome check
bun run --cwd plugins/plugin-native-mobile-signals format                    # write formatting
bun run --cwd plugins/plugin-native-mobile-signals format:check              # read-only formatting check
bun run --cwd plugins/plugin-native-mobile-signals test                      # run package tests
bun run --cwd plugins/plugin-native-mobile-signals prepublishOnly            # publish-time build hook
bun run --cwd plugins/plugin-native-mobile-signals watch                     # watch TypeScript sources
bun run --cwd plugins/plugin-native-mobile-signals build:unlocked            # bun run clean && bunx tsc -p tsconfig.json && bunx rollup -c rollup.config.mjs
bun run --cwd plugins/plugin-native-mobile-signals validate:ios-screen-time  # node scripts/validate-ios-screen-time.mjs
```

## Config / env vars

| Variable | Required | Description |
|---|---|---|
| `MOBILE_SIGNALS_IOS_PROVISIONING_PROFILE` | No | Path to the `.mobileprovision` file used by `validate:ios-screen-time` to verify Screen Time entitlements in the provisioning profile. |
| `MOBILE_SIGNALS_REQUIRE_IOS_PROVISIONING_PROFILE` | No | Set to `"1"` to make `validate:ios-screen-time` fail if no provisioning profile is supplied. |

No runtime environment variables are read by the plugin itself. Permission state and capabilities are determined at runtime by querying native APIs.

## iOS requirements

Screen Time / DeviceActivity features require additional entitlements and Xcode targets. The `validate:ios-screen-time` script checks:

1. `App.entitlements` contains `com.apple.developer.family-controls`.
2. Xcode project sets `CODE_SIGN_ENTITLEMENTS = App/App.entitlements`.
3. `DeviceActivityMonitorExtension` and `DeviceActivityReportExtension` app-extension targets exist and are embedded.
4. `ElizaosCapacitorMobileSignals.podspec` links `FamilyControls` and `DeviceActivity` frameworks.

Without these, `screenTime.supported` will be `false` and `screenTime.authorization.status` will be `"unavailable"`.

## Android requirements

The Android implementation uses `PACKAGE_USAGE_STATS` permission (requires the user to grant Usage Access in system settings — cannot be requested via a normal permission dialog). On Android the screen-time equivalent is `Health Connect` and `UsageStatsManager`. The plugin exposes `openSettings({ target: "usageAccess" })` to direct the user to the correct settings page.

## How to extend

**Add a new method to the plugin:**

1. Add the method signature to `MobileSignalsPlugin` interface in `src/definitions.ts`.
2. Add any new input/output types to `src/definitions.ts`.
3. Implement the method in `src/web.ts` (`MobileSignalsWeb` class) — return a graceful fallback for web.
4. Implement in `ios/Sources/MobileSignalsPlugin/MobileSignalsPlugin.swift`.
5. Implement in `android/src/main/java/ai/eliza/plugins/mobilesignals/MobileSignalsPlugin.kt`.
6. Rebuild: `bun run --cwd plugins/plugin-native-mobile-signals build`.

**Add a new signal field:**

Extend `MobileSignalsSnapshot` or `MobileSignalsHealthSnapshot` in `src/definitions.ts`, then propagate through the native implementations and the web fallback's `buildSnapshot` / `buildHealthSnapshot` helpers in `src/web.ts`.

## Conventions / gotchas

- **Instrumented test (issue #9967).** The `PACKAGE_USAGE_STATS` reads (AppOps `GET_USAGE_STATS` check + `UsageStatsManager.queryUsageStats`) live in `UsageStatsReader`; the plugin delegates to it (single source) so an on-device `androidTest` can drive the real provider. The permission is special-access, so the harness grants it host-side (`appops set <pkg> android:get_usage_stats allow`) and the usage tests `Assume`-skip when absent — verified positive on an API-34 emulator (real foreground-usage history).
- This is a **Capacitor plugin**, not an elizaOS action/provider/service plugin. There is no `Plugin` object registered with `AgentRuntime`. It is consumed by a Capacitor-enabled mobile/web app.
- The web fallback (`src/web.ts`) always returns `status: "not-applicable"` for `checkPermissions` and `false` for health capabilities. Do not add health data to the web path.
- `rawUsageExportAvailable` is permanently `false` in `MobileSignalsScreenTimeStatus` — this is intentional (Apple does not expose raw usage export).
- On iOS, Screen Time features require Apple's restricted `com.apple.developer.family-controls` entitlement, which must be provisioned by Apple. The `validate:ios-screen-time` script is the canonical check.
- `dist/` is committed for publishing but should be regenerated via `build` before any release.
- The package uses three outputs: ESM (`dist/esm/`) for tree-shaking consumers, CJS (`dist/plugin.cjs.js`) for CommonJS hosts, and IIFE (`dist/plugin.js`) for unpkg/browser script-tag use. The `bun`/`development` export condition resolves directly to `src/index.ts` for local dev.
- See root `AGENTS.md` for repo-wide conventions (logging, ESM, naming, architecture rules).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->

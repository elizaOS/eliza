# @elizaos/capacitor-wifi

Android Wi-Fi (WifiManager) bridge for elizaOS — a Capacitor plugin.

## Purpose / role

This is a Capacitor plugin (not an elizaOS runtime plugin). It exposes Android `WifiManager` / `ConnectivityManager` APIs to a Capacitor-hosted elizaOS app running on Android. It is NOT a runtime action/provider/service registered with `AgentRuntime`; it is a native bridge consumed by JavaScript code in the host app. On web/desktop it loads a safe fallback (`WiFiWeb`) that resolves with empty data and logs one warning.

Package: `@elizaos/capacitor-wifi`. Must be explicitly installed and integrated into a Capacitor Android project. Not auto-enabled.

## Plugin surface

This is a Capacitor plugin, not an elizaOS runtime plugin. It does not register actions, providers, services, or evaluators. It exposes one Capacitor plugin object:

| Export | Description |
|--------|-------------|
| `WiFi` | Capacitor plugin instance registered as `"ElizaWiFi"`. Call its methods from JS. |
| `WiFiPlugin` | TypeScript interface declaring all five methods. |
| `WiFiNetwork`, `ConnectedNetworkResult`, `WifiStateResult`, `ListNetworksResult`, `ConnectResult`, `ListNetworksOptions`, `ConnectOptions` | All DTO types. |

### `WiFiPlugin` methods

| Method | Returns | Notes |
|--------|---------|-------|
| `getWifiState()` | `WifiStateResult` | Radio enabled, connected bool, active RSSI (dBm or null). |
| `getConnectedNetwork()` | `ConnectedNetworkResult` | Active connection details or null. Requires `ACCESS_WIFI_STATE`. |
| `listAvailableNetworks(opts?)` | `ListNetworksResult` | Triggers or reuses a scan; de-duplicates by SSID; sorted by signal strength. Requires `ACCESS_WIFI_STATE` + `ACCESS_FINE_LOCATION` on API 26+. |
| `connectToNetwork(opts)` | `ConnectResult` | Uses `WifiNetworkSuggestion` on API 29+; `WifiConfiguration` (deprecated) on API 23–28. |
| `disconnectFromNetwork()` | `ConnectResult` | Calls `WifiManager.disconnect()`. Requires `CHANGE_WIFI_STATE`. |

## Layout

```
plugins/plugin-native-wifi/
  src/
    definitions.ts          All TypeScript interfaces and DTO types (WiFiPlugin, WiFiNetwork, …)
    index.ts                registerPlugin("ElizaWiFi") + re-exports definitions
    web.ts                  WiFiWeb: explicit WebPlugin fallback used in browser/Node environments
    web.test.ts             Vitest tests for the WiFiWeb fallback
  android/
    src/main/
      AndroidManifest.xml   Declares required permissions (ACCESS_WIFI_STATE, CHANGE_WIFI_STATE, ACCESS_FINE_LOCATION, …)
      java/ai/eliza/plugins/wifi/
        WiFiPlugin.kt       Kotlin implementation; all five @PluginMethod handlers + helpers
    build.gradle            Android library config (namespace ai.eliza.plugins.wifi, minSdk 23, compileSdk 34)
  rollup.config.mjs         Bundles dist/plugin.js (IIFE) and dist/plugin.cjs.js
  tsconfig.json             TypeScript config for the TS→ESM step
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-wifi clean           # remove build output
bun run --cwd plugins/plugin-native-wifi build           # build package artifacts
bun run --cwd plugins/plugin-native-wifi typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-wifi lint            # mutating Biome check
bun run --cwd plugins/plugin-native-wifi lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-wifi format          # write formatting
bun run --cwd plugins/plugin-native-wifi format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-wifi test            # run package tests
bun run --cwd plugins/plugin-native-wifi prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-wifi build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / env vars

None. This plugin reads no environment variables and has no elizaOS config keys. Android permissions are declared in `AndroidManifest.xml` and must be granted at runtime by the host app.

Required Android permissions (runtime-requested by the host app):
- `ACCESS_WIFI_STATE` — required by `getConnectedNetwork` and `listAvailableNetworks`.
- `CHANGE_WIFI_STATE` — required by `connectToNetwork` and `disconnectFromNetwork`.
- `ACCESS_FINE_LOCATION` — required for `WifiManager.scanResults` on API 26+ (Android 8+); without it the plugin rejects `listAvailableNetworks` with an error (does NOT silently return an empty list).
- `ACCESS_NETWORK_STATE`, `CHANGE_NETWORK_STATE` — used by the `ConnectivityManager.requestNetwork` path on API 29+.

## How to extend

To add a new method to this Capacitor plugin:

1. **Define the TypeScript signature** in `src/definitions.ts` — add the method to `WiFiPlugin` and any new DTOs.
2. **Add the web fallback** in `src/web.ts` inside `WiFiWeb`. It must satisfy the new interface and should resolve with empty/false data and call `warnOnce()`.
3. **Implement in Kotlin** in `android/src/main/java/ai/eliza/plugins/wifi/WiFiPlugin.kt` — annotate the method with `@PluginMethod`. Reject with a clear string on missing permissions rather than letting the platform silently return empty data.
4. Add any new Android permissions to `android/src/main/AndroidManifest.xml` with a comment explaining why they are needed.
5. Rebuild: `bun run --cwd plugins/plugin-native-wifi build`.

## Conventions / gotchas

- **Android-only native functionality.** The web fallback intentionally returns empty results; do not make it throw. Consumers on non-Android platforms receive empty results, not errors.
- **Scan rate-limiting.** `WifiManager.startScan()` is throttled by Android (typically 4 scans per 2 minutes in foreground). The `maxAge` option lets callers reuse a recent scan result. `startScan()` returning `false` is expected on modern Android — use the returned `scanResults` regardless.
- **API level branching in `connectToNetwork`.** API 29+ uses `WifiNetworkSuggestion` (the system controls the actual connection; success means the suggestion was accepted, not that the device is connected). API 23–28 uses the deprecated `WifiConfiguration` path, which only works for privileged system apps. Poll `getConnectedNetwork()` to observe actual connection state after calling `connectToNetwork`.
- **`ACCESS_FINE_LOCATION` is required for scans.** The plugin rejects `listAvailableNetworks` with an explicit error on API 26+ if the permission is not granted, instead of silently returning an empty list. The host app must prompt the user and retry.
- **Build requires Android SDK.** The Kotlin plugin only compiles as part of an Android Gradle project; running `bun run build` builds only the TypeScript/JS artifacts. The Kotlin source is compiled by Gradle when the Capacitor plugin is synced into an Android project. The Wi-Fi state read is covered by an **instrumented test** (`android/src/androidTest/.../WiFiStateReaderInstrumentedTest.kt`) run on a real device/emulator via `./gradlew :elizaos-capacitor-wifi:connectedDebugAndroidTest` from `packages/app-core/platforms/android` (issue #9967); the read lives in `WiFiStateReader` so it is exercisable without a Capacitor `Bridge`/WebView.
- **Capacitor peer dep.** `@capacitor/core ^8.3.1` must be present in the host app. This package declares it as both a `peerDependency` and a `devDependency`.

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

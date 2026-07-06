# @elizaos/capacitor-websiteblocker

Capacitor plugin that enforces website blocking across browser, Android (split-tunnel VPN DNS), and iOS (native Safari content blocker) from a single TypeScript API surface.

## Purpose / role

This is a **Capacitor plugin**, not an elizaOS runtime plugin. It does not register elizaOS actions, providers, services, or evaluators. It exposes a JS/TS interface (`WebsiteBlocker`) that Capacitor-hosted Eliza app shells call directly. On **browser/web** the plugin delegates to the Eliza runtime HTTP API (`/api/website-blocker`). On **Android** it drives a foreground split-tunnel VPN service with DNS-level blocking. On **iOS** it manages a Safari content-blocker extension via `SFContentBlockerManager` and a shared App Group `UserDefaults` store.

Package name: `@elizaos/capacitor-websiteblocker`. Not auto-enabled; must be installed and registered in the Capacitor app shell.

## Plugin surface

This plugin exposes one Capacitor plugin object with six methods (not elizaOS actions):

| Method | Description |
|---|---|
| `WebsiteBlocker.getStatus()` | Returns full blocker state: active, websites, engine, permission, endsAt |
| `WebsiteBlocker.startBlock(options)` | Starts blocking; accepts `websites[]`, optional `durationMinutes`, optional `text` (hostname extraction) |
| `WebsiteBlocker.stopBlock()` | Removes block state and tears down the active blocker |
| `WebsiteBlocker.checkPermissions()` | Returns current permission status without prompting |
| `WebsiteBlocker.requestPermissions()` | Triggers the platform consent flow (VPN consent on Android, Settings redirect on iOS) |
| `WebsiteBlocker.openSettings()` | Opens VPN settings (Android) or Safari Extensions settings (iOS) |

No elizaOS `Plugin` object. No actions, providers, evaluators, services, or routes.

## Layout

```
src/
  index.ts           Plugin registration via registerPlugin("ElizaWebsiteBlocker");
                       re-exports all definitions and backend exports
  definitions.ts     All exported TS types: WebsiteBlockerPlugin interface, options, result unions
  web.ts             WebsiteBlockerWeb — browser impl; delegates to Eliza HTTP API
                       GET  /api/website-blocker          → getStatus
                       PUT  /api/website-blocker          → startBlock
                       DELETE /api/website-blocker        → stopBlock
                       GET  /api/permissions/website-blocking              → checkPermissions
                       POST /api/permissions/website-blocking/request      → requestPermissions
                       POST /api/permissions/website-blocking/open-settings → openSettings
  backend.ts         NativeWebsiteBlockerBackend adapter — wraps the Capacitor plugin as the
                       backend interface that @elizaos/plugin-blocker dispatches to; exports
                       createNativeWebsiteBlockerBackend() factory and NativeWebsiteBlockerBackend
                       interface

android/src/main/java/ai/eliza/plugins/websiteblocker/
  WebsiteBlockerPlugin.kt      Capacitor @CapacitorPlugin("ElizaWebsiteBlocker"); all PluginMethods
  WebsiteBlockerVpnService.kt  Foreground VPN service; DNS-level blocking via split tunnel
  WebsiteBlockerStateStore.kt  SharedPreferences persistence; hostname normalization
  WebsiteBlockerBootReceiver.kt Restarts VPN service after device reboot
  DnsPacketCodec.kt            DNS packet parsing/synthesis for VPN intercept
android/src/androidTest/java/ai/eliza/plugins/websiteblocker/
  WebsiteBlockerStateStoreInstrumentedTest.kt  On-device SharedPreferences + DNS policy tests
  WebsiteBlockerShowcaseActivity.kt            Test-only rendered state for screenshots/recordings

ios/Sources/WebsiteBlockerPlugin/
  WebsiteBlockerPlugin.swift   @objc(ElizaWebsiteBlockerPlugin); all CAPPluginMethods
  WebsiteBlockerShared.swift   Shared state (App Group UserDefaults key website_blocker_state_v1),
                                content blocker rule generation, SFContentBlockerManager reload

ElizaosCapacitorWebsiteBlocker.podspec  CocoaPods spec for iOS integration
rollup.config.mjs                       CJS + ESM bundle config
tsconfig.json                           TS build config
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-websiteblocker clean                # remove build output
bun run --cwd plugins/plugin-native-websiteblocker build                # build package artifacts
bun run --cwd plugins/plugin-native-websiteblocker typecheck            # TypeScript typecheck
bun run --cwd plugins/plugin-native-websiteblocker lint                 # mutating Biome check
bun run --cwd plugins/plugin-native-websiteblocker lint:check           # read-only Biome check
bun run --cwd plugins/plugin-native-websiteblocker format               # write formatting
bun run --cwd plugins/plugin-native-websiteblocker format:check         # read-only formatting check
bun run --cwd plugins/plugin-native-websiteblocker test                 # run package tests
bun run --cwd plugins/plugin-native-websiteblocker test:android:manual  # manual Android/Gradle test lane
bun run --cwd plugins/plugin-native-websiteblocker prepublishOnly       # publish-time build hook
bun run --cwd plugins/plugin-native-websiteblocker build:unlocked       # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / env vars

**No elizaOS env vars or character settings.** The web implementation reads two browser globals injected by the Eliza app shell at runtime:

| Global | Source | Purpose |
|---|---|---|
| boot-config `apiBase` (`window.__ELIZAOS_APP_BOOT_CONFIG__`) | App shell injects at init | Base URL for Eliza HTTP API (`""` = same origin) |
| `window.__ELIZA_API_TOKEN__` | App shell or `sessionStorage.eliza_api_token` | Bearer token for authenticated API calls |

Android and iOS do not use env vars; state is stored in `SharedPreferences` (Android) and App Group `UserDefaults` with suite name `group.<bundleId>` (iOS).

## How to extend

### Add a new method to the plugin interface

1. Add the signature to `WebsiteBlockerPlugin` in `src/definitions.ts`.
2. Implement the method in `src/web.ts` (`WebsiteBlockerWeb` class) calling the appropriate Eliza HTTP API endpoint.
3. Add the method to `ios/Sources/WebsiteBlockerPlugin/WebsiteBlockerPlugin.swift`: register it in `pluginMethods` and add the `@objc func` handler.
4. Add `@PluginMethod fun <name>(call: PluginCall)` in `android/src/main/java/ai/eliza/plugins/websiteblocker/WebsiteBlockerPlugin.kt`.
5. Rebuild: `bun run --cwd plugins/plugin-native-websiteblocker build`.

### Add a new type

All public TS types live in `src/definitions.ts`. Keep them co-located; do not scatter type definitions across files.

## Conventions / gotchas

- **Not an elizaOS runtime plugin.** There is no `export default { name, actions, ... }`. Do not add one unless the plugin is converted to a full elizaOS plugin.
- **iOS requires an App Group.** The Safari content blocker extension and the main app share state via `UserDefaults(suiteName: "group.<bundleId>")`. If the App Group entitlement is missing, `saveState` throws and blocking fails silently from the caller's perspective.
- **iOS content blocker must be enabled by the user in Settings > Safari > Extensions.** `startBlock` succeeds in saving state but returns `success: false` with a descriptive error if the extension is disabled. The caller must handle this and prompt the user to open Settings.
- **Android VPN consent flow is async.** `startBlock` may redirect to `handleVpnPermissionResult` via `startActivityForResult` before actually starting the VPN service. The `pendingStartRequest` field on `WebsiteBlockerPlugin.kt` bridges the two phases.
- **Android blocks survive reboot** via `WebsiteBlockerBootReceiver` (registered in `AndroidManifest.xml`).
- **Hostname normalization** strips protocols, paths, trailing dots, and invalid characters. Hostnames without a dot are rejected. Canonical logic: `WebsiteBlockerShared.normalizeHostname` (Swift) / `WebsiteBlockerStateStore.normalizeHostname` (Kotlin).
- **x.com / twitter.com expansion.** Blocking `x.com` or `twitter.com` automatically expands to the full set of subdomains (`mobile.x.com`, `t.co`, CDN domains, etc.) and allowlists `api.x.com`. See `xTwitterBlockedWebsites` / `xTwitterAllowedWebsites` in `WebsiteBlockerShared.swift` and equivalent logic in `WebsiteBlockerStateStore.kt`.
- **Build output.** `dist/esm/index.js` + `dist/plugin.cjs.js`. The `bun` and `development` export conditions map directly to `src/index.ts` for fast local iteration.
- See the root `AGENTS.md` for repo-wide architecture rules, logger conventions, and git workflow.

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

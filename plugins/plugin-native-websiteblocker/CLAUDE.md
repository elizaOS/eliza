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
  index.ts           Plugin registration via registerPlugin("ElizaWebsiteBlocker")
  definitions.ts     All exported TS types: WebsiteBlockerPlugin interface, options, result unions
  web.ts             WebsiteBlockerWeb — browser impl; delegates to Eliza HTTP API
                       GET  /api/website-blocker          → getStatus
                       PUT  /api/website-blocker          → startBlock
                       DELETE /api/website-blocker        → stopBlock
                       GET  /api/permissions/website-blocking              → checkPermissions
                       POST /api/permissions/website-blocking/request      → requestPermissions
                       POST /api/permissions/website-blocking/open-settings → openSettings

android/src/main/java/ai/eliza/plugins/websiteblocker/
  WebsiteBlockerPlugin.kt      Capacitor @CapacitorPlugin("ElizaWebsiteBlocker"); all PluginMethods
  WebsiteBlockerVpnService.kt  Foreground VPN service; DNS-level blocking via split tunnel
  WebsiteBlockerStateStore.kt  SharedPreferences persistence; hostname normalization
  WebsiteBlockerBootReceiver.kt Restarts VPN service after device reboot
  DnsPacketCodec.kt            DNS packet parsing/synthesis for VPN intercept

ios/Sources/WebsiteBlockerPlugin/
  WebsiteBlockerPlugin.swift   @objc(ElizaWebsiteBlockerPlugin); all CAPPluginMethods
  WebsiteBlockerShared.swift   Shared state (App Group UserDefaults key website_blocker_state_v1),
                                content blocker rule generation, SFContentBlockerManager reload

ElizaosCapacitorWebsiteBlocker.podspec  CocoaPods spec for iOS integration
rollup.config.mjs                       CJS + ESM bundle config
tsconfig.json                           TS build config
```

## Commands

```bash
bun run --cwd plugins/plugin-native-websiteblocker build        # tsc + rollup (outputs dist/)
bun run --cwd plugins/plugin-native-websiteblocker clean        # remove dist/
bun run --cwd plugins/plugin-native-websiteblocker test:android:manual  # Gradle unit tests
```

`prepublishOnly` runs `build` automatically on `npm publish`.

## Config / env vars

**No elizaOS env vars or character settings.** The web implementation reads two browser globals injected by the Eliza app shell at runtime:

| Global | Source | Purpose |
|---|---|---|
| `window.__ELIZA_API_BASE__` | App shell injects at init | Base URL for Eliza HTTP API (`""` = same origin) |
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

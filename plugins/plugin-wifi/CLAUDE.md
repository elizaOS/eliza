# @elizaos/plugin-wifi

Android-only overlay app that lets an Eliza agent scan, inspect, and connect to nearby Wi-Fi networks.

## Purpose / role

Adds a Wi-Fi management surface to the elizaOS mobile agent on Android. It registers a `wifiNetworks` provider that injects nearby network context into the agent's planner, and a full-screen overlay UI (`WifiAppView`) that the user can open from the app catalog. The plugin is opt-in: it is only registered in the overlay app catalog when `isElizaOS()` returns true (i.e., running inside the elizaOS Android host). On all other platforms (iOS, desktop, web) the side-effect entry is a no-op.

## Plugin surface

The `/plugin` export (`src/plugin.ts`) registers:

| Kind | Name | Description |
|------|------|-------------|
| Provider | `wifiNetworks` | Dynamic, read-only nearby Wi-Fi networks (ssid, bssid, rssi, frequency, secured). Context gate: `system`. Cache scope: `turn`. Calls `@elizaos/capacitor-wifi` `WiFi.listAvailableNetworks`. |

No actions, evaluators, routes, or events are registered.

The overlay UI surface (registered via `src/register.ts` side-effect):

| Export | Description |
|--------|-------------|
| `wifiApp` | `OverlayApp` descriptor (name, displayName, category: "system", androidOnly: true). |
| `registerWifiApp()` | Registers `wifiApp` with `@elizaos/ui`'s overlay app registry. Called automatically on elizaOS Android. |
| `WifiAppView` | React component. Full-screen overlay: shows connected network, scans for nearby networks, connects/disconnects with optional password entry. |

## Layout

```
src/
  index.ts              Public barrel — re-exports everything below
  plugin.ts             appWifiPlugin: Plugin — registers wifiNetworks provider
  register.ts           Side-effect entry — calls registerWifiApp() if isElizaOS()
  ui.ts                 UI barrel — re-exports WifiAppView + wifi-app helpers
  providers/
    networks.ts         wifiNetworksProvider — calls WiFi.listAvailableNetworks, limit 25
  components/
    wifi-app.ts         wifiApp OverlayApp descriptor + registerWifiApp()
    WifiAppView.tsx     Full-screen React overlay UI (scan, connect, disconnect)
assets/
  hero.png              App catalog hero image
```

## Commands

```bash
bun run --cwd plugins/plugin-wifi typecheck   # tsgo type-check only (no emit)
bun run --cwd plugins/plugin-wifi lint        # biome check src/
bun run --cwd plugins/plugin-wifi test        # vitest run
bun run --cwd plugins/plugin-wifi build       # tsup + tsc declarations → dist/
bun run --cwd plugins/plugin-wifi clean       # rm -rf dist
```

## Config / env vars

No env vars or settings keys. The plugin reads no process environment at runtime. `@elizaos/capacitor-wifi` talks directly to the Android WifiManager via Capacitor; Android `ACCESS_FINE_LOCATION` permission must be granted at the OS level for scans to succeed.

## How to extend

**Add a provider:** Create `src/providers/<name>.ts` exporting a `Provider` object, then add it to the `providers` array in `src/plugin.ts`. Re-export it from `src/index.ts`.

**Add an action:** Create `src/actions/<name>.ts` exporting an `Action` object. Add an `actions` array to `appWifiPlugin` in `src/plugin.ts` and push the new action into it. Re-export from `src/index.ts`.

**Add a service:** Create `src/services/<name>.ts` extending `Service`. Register it in `appWifiPlugin.services`. Ensure it is exported from `src/index.ts`.

## Conventions / gotchas

- **Android-only.** `WifiAppView` and `registerWifiApp()` are safe to import on non-Android platforms but `@elizaos/capacitor-wifi` methods will reject or return empty results everywhere except Android. The `register.ts` entry guards registration behind `isElizaOS()`.
- **No server routes.** `WifiAppView` owns all its data by calling the Capacitor plugin directly; there is no backend API involved.
- **Scan limit.** `wifiNetworksProvider` caps at 25 networks; `WifiAppView` caps its own scan at 50. Keep these consistent if raising the limit.
- **Location permission.** Android requires `ACCESS_FINE_LOCATION` for `WifiManager.startScan`. If the permission is denied, scans succeed silently with an empty list or throw; the provider maps errors to `wifiNetworksError` in `values`.
- **Provider context gate.** `wifiNetworksProvider` uses `contextGate: { anyOf: ["system"] }` — it only fires in system-context conversations, not every agent turn.
- **`elizaos.app` metadata.** `package.json` carries an `elizaos.app` block (`displayName: "WiFi"`, `category: "system"`, `androidOnly: true`, `heroImage: "assets/hero.png"`) used by the app catalog tooling.
- **Root AGENTS.md.** Repo-wide architecture rules, logger conventions, ESM requirements, and naming rules live in the root `AGENTS.md`. This file covers only plugin-wifi specifics.

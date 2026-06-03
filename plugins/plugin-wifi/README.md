# @elizaos/plugin-wifi

Wi-Fi overlay app for the elizaOS Android agent. Scan, inspect, and connect to nearby Wi-Fi networks from within the elizaOS mobile interface.

## What it does

- Displays the currently connected Wi-Fi network (SSID, signal strength, frequency).
- Scans for nearby networks and lists them sorted by signal strength.
- Lets the user tap a network, enter a password if required, and connect.
- Surfaces nearby network data (SSID, BSSID, RSSI, frequency, security) to the agent planner as the `wifiNetworks` provider.

## Android-only

This plugin is only functional on Android. The overlay app is registered in the elizaOS app catalog exclusively when running inside the elizaOS Android host. On other platforms (iOS, desktop, web) the side-effect registration leaves the app catalog unchanged. `@elizaos/capacitor-wifi` uses Android's `WifiManager` API directly.

## Capabilities added to an Eliza agent

| Surface | Name | Description |
|---------|------|-------------|
| Provider | `wifiNetworks` | Dynamic provider gated to the `system` context (`contextGate: { anyOf: ["system"] }`); injects up to 25 nearby Wi-Fi networks when that context is selected for a turn. Fields per network: `ssid`, `bssid`, `rssi` (dBm), `frequency` (MHz), `secured` (boolean). |
| Overlay UI | WiFi | Full-screen app accessible from the elizaOS app catalog. Scan, view connected network, connect/disconnect. |

## Required permissions

Android `ACCESS_FINE_LOCATION` must be granted at the OS level before Wi-Fi scans can return results. The plugin does not prompt for this permission itself — it relies on the host app's permission flow.

## Enabling the plugin

Register it in your elizaOS agent configuration by importing from the `/plugin` export:

```ts
import wifiPlugin from "@elizaos/plugin-wifi/plugin";
// or
import { appWifiPlugin } from "@elizaos/plugin-wifi/plugin";
```

The overlay UI registers itself automatically when the package is loaded on an elizaOS Android host (via the `register.ts` side-effect entry). No additional setup is required.

## Package exports

| Export path | Contents |
|-------------|----------|
| `@elizaos/plugin-wifi` | Full barrel: plugin, UI components, registration helpers |
| `@elizaos/plugin-wifi/plugin` | `appWifiPlugin` (the `Plugin` object with the `wifiNetworks` provider) |

## Dependencies

- `@elizaos/capacitor-wifi` — Capacitor plugin wrapping Android WifiManager.
- `@elizaos/capacitor-system` — Used by the UI to open Android network settings.
- `@elizaos/ui` — Overlay app registry + shared UI primitives.
- `@elizaos/core` — elizaOS plugin and provider types.

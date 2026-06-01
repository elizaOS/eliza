# @elizaos/capacitor-wifi

Android Wi-Fi bridge for elizaOS apps built on Capacitor. Exposes `WifiManager` and `ConnectivityManager` APIs to JavaScript running inside a Capacitor Android shell.

## What this plugin does

This Capacitor plugin gives a Capacitor-hosted elizaOS app access to the Android Wi-Fi stack from JavaScript/TypeScript:

- Read the current Wi-Fi radio state (enabled, connected, signal strength).
- Retrieve the active connection details (SSID, BSSID, frequency, RSSI).
- Scan for nearby networks and receive a deduplicated list sorted by signal strength.
- Connect to a network by SSID (open or WPA2-protected, visible or hidden).
- Disconnect from the current network.

On web/desktop, all methods resolve safely with empty data and a one-time console warning — the app compiles and runs without errors, but real Wi-Fi operations only work on Android.

## Capabilities

| Method | What it does |
|--------|-------------|
| `WiFi.getWifiState()` | Returns `{ enabled, connected, rssi }` for the Wi-Fi radio. |
| `WiFi.getConnectedNetwork()` | Returns the active `WiFiNetwork` or `null`. |
| `WiFi.listAvailableNetworks(opts?)` | Triggers (or reuses) a scan and returns a deduplicated `WiFiNetwork[]`. |
| `WiFi.connectToNetwork({ ssid, password?, hidden? })` | Requests a connection; uses `WifiNetworkSuggestion` on Android 10+ and the legacy `WifiConfiguration` path on Android 6–9. |
| `WiFi.disconnectFromNetwork()` | Disconnects the active network. |

## Requirements

- Android only. Minimum SDK: 23 (Android 6.0).
- `@capacitor/core ^8.3.1` as a peer dependency.

### Android permissions

Declared in the plugin's `AndroidManifest.xml`; the host app must request runtime grants where required:

| Permission | Required by |
|-----------|-------------|
| `ACCESS_WIFI_STATE` | `getConnectedNetwork`, `listAvailableNetworks` |
| `CHANGE_WIFI_STATE` | `connectToNetwork`, `disconnectFromNetwork` |
| `ACCESS_FINE_LOCATION` | `listAvailableNetworks` on Android 8+ (API 26+) — without it scan results are empty |
| `ACCESS_NETWORK_STATE`, `CHANGE_NETWORK_STATE` | `connectToNetwork` on Android 10+ (`WifiNetworkSuggestion` path) |

## Installation

```bash
npm install @elizaos/capacitor-wifi
npx cap sync android
```

Then sync the Capacitor project so Gradle includes the plugin:

```bash
npx cap sync
```

## Usage

```typescript
import { WiFi } from '@elizaos/capacitor-wifi';

// Read radio state
const state = await WiFi.getWifiState();
console.log('Wi-Fi enabled:', state.enabled, 'Connected:', state.connected);

// List nearby networks
const { networks } = await WiFi.listAvailableNetworks({ maxAge: 15000, limit: 20 });
for (const net of networks) {
  console.log(net.ssid, net.rssi, 'dBm', net.secured ? '(secured)' : '(open)');
}

// Connect
const result = await WiFi.connectToNetwork({ ssid: 'MyNetwork', password: 'secret' });
if (!result.success) console.error(result.message);
```

## Notes

- `connectToNetwork` on Android 10+ submits a `WifiNetworkSuggestion`. The call resolving with `success: true` means the suggestion was accepted by the system, not that the device is connected. Poll `getConnectedNetwork()` to observe connection state.
- Wi-Fi scanning is rate-limited by Android (roughly 4 scans per 2 minutes in the foreground). Use the `maxAge` option to reuse a recent scan and avoid hitting the throttle.
- The plugin rejects `listAvailableNetworks` with a clear error on API 26+ when `ACCESS_FINE_LOCATION` is not granted, rather than silently returning an empty list.

## License

MIT

# @elizaos/plugin-native-wifi

Android-only overlay app that lets an Eliza agent scan, inspect, and connect to nearby
Wi-Fi networks.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

Scanning requires Android location permission and the native mobile shell.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-wifi build  # build
```

Android 10+ connection success means an Internet network suggestion was accepted,
not that association completed. Do not create a second local-only peer request or
retain network callbacks. Connection security comes from Android security type
or a matching scan result; unavailable security rejects rather than reporting open.

`addNetworkWithApproval` (Android 11+) opens the system "Save this network?"
dialog, so ordinary apps can join a network without a privileged permission.
It resolves `connected` or `captivePortal` only when Android reports that
state for a Wi-Fi network whose own name equals the requested SSID; another
Wi-Fi network, such as the one already joined, never counts. Android discloses
names only with location access and Location on. When no matching network is
confirmed within 30 seconds it resolves `unverified` if a working Wi-Fi network
with a withheld name was seen, otherwise `notConnected`.
`getConnectivity` reports Android's own Internet
validation and captive-portal state for the active network.

`addNetworkWithApproval` and `connectToNetwork` take the scan result's
`security` (`open`, `owe`, `wpa2` or `wpa3`), so WPA3-only and Enhanced Open
networks can join. A join with a password resolves `wrongPassword` when Android
reports an authentication failure while it waits; that report is best-effort.

`listAvailableNetworks` waits up to `timeout` (10 seconds) for a started scan.
It rejects with `LOCATION_PERMISSION_REQUIRED` or `LOCATION_DISABLED` instead
of returning an empty list; request the `location` alias with
`requestPermissions`. `joinable: true` leaves out EAP and WEP networks.
`openInternetPanel` opens Android's internet panel and `getCapabilities` says
which of these paths the device supports.

A host that must limit the bridge registers a subclass that overrides
`protected open fun enabled()`. Every method, including the permission
methods, then rejects with `DISABLED`. The subclass declares its own
`@CapacitorPlugin` with a name and the `location` permission alias, because
Capacitor does not inherit the annotation.

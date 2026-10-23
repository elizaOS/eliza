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
state for a Wi-Fi network that appeared after the dialog opened, or for an
already-joined network whose disclosed name matches. Without location access
Android hides network names, so rejoining the current network then reports
`notConnected`. `getConnectivity` reports Android's own Internet
validation and captive-portal state for the active network.

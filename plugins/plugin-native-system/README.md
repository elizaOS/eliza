# @elizaos/capacitor-system

A Capacitor plugin that bridges Android system-role status and device-settings control
into the elizaOS mobile runtime.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-system build  # build
bun run --cwd plugins/plugin-native-system test   # tests
```

## Android device verification

From the repository root, run `node packages/app/scripts/android-native-plugins.ts --serial <emulator> --plugin plugin-native-system --system-controls` on an isolated stock emulator without the user app. This verifies real brightness and music-volume changes, clamping, permission denial/revocation, and restoration against Android settings and AudioManager. A second instrumentation process verifies recovery of persisted original settings after the first process exits with changes outstanding. Reports include bridge receipts and native observations. Role-picker, flashlight, and physical-device behavior require separate coverage.

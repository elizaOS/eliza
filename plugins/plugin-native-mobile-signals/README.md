# @elizaos/capacitor-mobile-signals

Capacitor plugin that bridges mobile wake, lock, battery, and protected-data state into
Eliza agents via the `MobileSignals` Capacitor plugin interface.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-mobile-signals build  # build
bun run --cwd plugins/plugin-native-mobile-signals test   # tests
```

Build the package before running `bun run validate:ios-screen-time`; the command uses the bundled validator shipped to consumers.

For Android, run `node packages/app/scripts/android-native-plugins.ts --serial
<emulator> --plugin plugin-native-mobile-signals` from the repository root. The
isolated test APK verifies real screen sleep/wake events through a Capacitor
WebView listener, duplicate starts, stop/restart, listener removal, and battery
snapshot values against Android. It waits for OS broadcast delivery and restores
the screen to awake. Reports contain complete signal payloads. Health records,
notification authorization, and physical-device behavior require separate tests.

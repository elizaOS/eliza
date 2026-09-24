# @elizaos/capacitor-appblocker

Capacitor plugin that blocks selected apps on Android (Usage Access + system overlay)
and iOS (Family Controls + ManagedSettings).

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-appblocker build  # build
bun run --cwd plugins/plugin-native-appblocker test   # tests
```

## Android device verification

Run `node packages/app/scripts/android-native-plugins.ts --plugin plugin-native-appblocker --serial <emulator>` from the repository root. The runner installs a separate disposable launcher app with a tap counter and records both APK hashes. Tests grant Usage Access and overlay access only to the test host, then verify discovery, intercepted taps, Go Home, unblock, live policy changes, a real one-minute timer replacement, and permission withdrawal/restoration. Screenshots and UI trees are exported with the report; test packages and grants are removed afterward.

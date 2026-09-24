# @elizaos/capacitor-location

A Capacitor plugin that provides geolocation services (current position, watch position,
permissions) to Eliza agents running in browser, Electrobun desktop, iOS, and Android
environments.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-location build  # build
bun run --cwd plugins/plugin-native-location test   # tests
```

Android uses Google fused location when Play Services is available and Android
`LocationManager` on AOSP. The emulator suite injects known coordinates and checks
reads, watch cancellation, and timeouts without silently skipping missing fixes:

```bash
node packages/app/scripts/android-native-plugins.ts --serial emulator-5554 --plugin plugin-native-location
```

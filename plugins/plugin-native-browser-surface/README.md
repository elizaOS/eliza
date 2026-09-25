# @elizaos/capacitor-browser-surface

Isolated native browser surfaces for mobile Browser tabs, exposed through the ElizaSurfaceManager Capacitor bridge.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-browser-surface build  # build
bun run --cwd plugins/plugin-native-browser-surface test   # tests
```

Android device tests exercise ownership, storage isolation, real WebView page
reads, navigation/back/reload, and visibility after rejected presentation:

```bash
node packages/app/scripts/android-native-plugins.ts --serial emulator-5554 --plugin plugin-native-browser-surface
```

The bridge fixture exports native screenshots and complete page-read results.

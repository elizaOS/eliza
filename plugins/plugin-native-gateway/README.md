# @elizaos/capacitor-gateway

Capacitor plugin that connects an elizaOS app to an Eliza Gateway server with discovery,
WebSocket RPC, and realtime event streaming — across web, iOS, and Android.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-gateway build  # build
bun run --cwd plugins/plugin-native-gateway test   # tests
```

Android bridge verification:

```bash
node packages/app/scripts/android-native-plugins.mjs --serial emulator-5554 --plugin plugin-native-gateway
```

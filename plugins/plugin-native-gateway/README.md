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

## Android device verification

The emulator suite drives the real WebView/Capacitor/OkHttp client against a
loopback WebSocket protocol peer. It verifies authentication, RPCs, pushed events,
reconnection, rejected handshakes, and cancellation of pending work.

```bash
node packages/app/scripts/android-native-plugins.ts --serial emulator-5554 --plugin plugin-native-gateway
```

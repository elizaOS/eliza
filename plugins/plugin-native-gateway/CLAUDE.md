# @elizaos/capacitor-gateway

Capacitor plugin that connects an elizaOS app to an Eliza Gateway server with discovery, WebSocket RPC, and realtime event streaming — across web, iOS, and Android.

## Purpose / role

This is a [Capacitor](https://capacitorjs.com/) plugin, not an elizaOS runtime plugin. It ships a cross-platform JavaScript API backed by platform-specific implementations (Swift on iOS, Kotlin on Android, browser WebSocket on web). It is registered as a Capacitor plugin named `"Gateway"` and consumed by the app layer to establish authenticated WebSocket sessions to a running Eliza Gateway.

This package is **not** loaded by the elizaOS `AgentRuntime`. It is a client-side networking primitive for the UI layer.

## Plugin surface

The `Gateway` object (exported from `src/index.ts`) is the single entry point. It implements `GatewayPlugin` (defined in `src/definitions.ts`):

| Method | Description |
|---|---|
| `startDiscovery(options?)` | Start Bonjour/mDNS discovery for gateways on the local network (LAN + optional wide-area DNS-SD). Not available on web. |
| `stopDiscovery()` | Stop active discovery. |
| `getDiscoveredGateways()` | Return the current snapshot of discovered `GatewayEndpoint[]`. |
| `connect(options)` | Open an authenticated WebSocket to a gateway URL; negotiates protocol v3; returns session ID, role, scopes, and available methods/events. |
| `disconnect()` | Close the active WebSocket; cancels reconnect timer. |
| `isConnected()` | Returns `{ connected: boolean }`. |
| `send(options)` | Send an RPC request (`method` + `params`); returns `GatewaySendResult` with `ok`, `payload`, or `error`. |
| `getConnectionInfo()` | Returns current `url`, `sessionId`, `protocol`, `role`. |
| `addListener("gatewayEvent", fn)` | Receive server-pushed events (`GatewayEvent`: `event`, `payload`, `seq`). |
| `addListener("stateChange", fn)` | Connection lifecycle: `connecting` / `connected` / `disconnected` / `reconnecting`. |
| `addListener("error", fn)` | Receive `GatewayErrorEvent` (`message`, `code`, `willRetry`). |
| `addListener("discovery", fn)` | Receive `GatewayDiscoveryEvent` (`found` / `lost` / `updated` + `GatewayEndpoint`). |
| `removeAllListeners()` | Remove all event listeners. |

## Layout

```
plugins/plugin-native-gateway/
  src/
    index.ts          Capacitor registerPlugin call; exports Gateway singleton + all types
    definitions.ts    All TypeScript interfaces: GatewayPlugin, GatewayEndpoint, events, DTOs
    web.ts            Browser WebSocket implementation (GatewayWeb extends WebPlugin)
  ios/
    Sources/GatewayPlugin/
      GatewayPlugin.swift   Swift implementation using URLSessionWebSocketTask + NWBrowser
  android/
    src/main/java/ai/eliza/plugins/gateway/
      GatewayPlugin.kt      Kotlin implementation using OkHttp WebSocket + NsdManager
  ElizaosCapacitorGateway.podspec  CocoaPods spec (pod name: ElizaosCapacitorGateway)
  rollup.config.mjs   Bundler config producing CJS + ESM dist
  tsconfig.json
```

## Commands

Scripts defined in `package.json`:

```bash
bun run --cwd plugins/plugin-native-gateway build           # tsc + rollup → dist/
bun run --cwd plugins/plugin-native-gateway build:docs      # docgen → README.md, then build
bun run --cwd plugins/plugin-native-gateway watch           # tsc --watch
bun run --cwd plugins/plugin-native-gateway lint            # biome check (+ swiftlint if installed)
bun run --cwd plugins/plugin-native-gateway lint:check      # biome check (read-only)
bun run --cwd plugins/plugin-native-gateway fmt             # biome check --write --unsafe
bun run --cwd plugins/plugin-native-gateway format          # biome format --write
bun run --cwd plugins/plugin-native-gateway format:check    # biome format (dry-run)
bun run --cwd plugins/plugin-native-gateway verify          # verify:ios + verify:android + verify:web
bun run --cwd plugins/plugin-native-gateway verify:web      # bun run build only
bun run --cwd plugins/plugin-native-gateway verify:ios      # pod install + xcodebuild
bun run --cwd plugins/plugin-native-gateway verify:android  # ./gradlew clean build test
bun run --cwd plugins/plugin-native-gateway docgen          # @capacitor/docgen → README.md + dist/docs.json
bun run --cwd plugins/plugin-native-gateway clean           # delete dist/
```

## Config / env vars

This plugin reads **no env vars** and has **no elizaOS config schema**. All configuration is passed at runtime through the `GatewayConnectOptions` argument to `Gateway.connect()`:

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | `string` | Yes | WebSocket URL of the gateway (e.g. `wss://host:8080`) |
| `token` | `string` | No | JWT or bearer token for auth |
| `password` | `string` | No | Password-based auth alternative to token |
| `clientName` | `string` | No | Sent in connect frame; defaults to `"eliza-capacitor"` |
| `clientVersion` | `string` | No | Defaults to `"1.0.0"` |
| `sessionKey` | `string` | No | Optional session key for chat sessions |
| `role` | `string` | No | Role to request; defaults to `"operator"` |
| `scopes` | `string[]` | No | Defaults to `["operator.admin"]` |

Discovery options via `GatewayDiscoveryOptions`:

| Field | Type | Description |
|---|---|---|
| `wideAreaDomain` | `string` | Optional DNS-SD domain for wide-area discovery (e.g. a Tailscale domain) |
| `timeout` | `number` | Discovery timeout in ms; default 10000 |

## Protocol

The gateway protocol uses JSON frames over WebSocket. Three frame types:

- `req` — client request: `{ type: "req", id: UUID, method: string, params: object }`
- `res` — server response: `{ type: "res", id: UUID, ok: boolean, payload?, error? }`
- `event` — server push: `{ type: "event", event: string, payload?, seq?: number }`

Connection is established by sending a `connect` method frame with protocol range `minProtocol: 3, maxProtocol: 3`. Reconnection uses exponential backoff starting at 800 ms, capped at 15 s (web, iOS, and Android). Request timeout is 60 s for `send()`.

mDNS service type: `_eliza-gw._tcp` (local.) on iOS/Android; `_eliza-gw._tcp.` on Android NsdManager.

## How to extend

**Add a typed helper around `send()`** (preferred pattern — do not modify this package):
- Import `Gateway` from `@elizaos/capacitor-gateway` in your app code.
- Call `Gateway.send({ method: "your.method", params: { ... } })` and type the result.

**Add a new method to the plugin interface:**
1. Add the signature to `GatewayPlugin` in `src/definitions.ts`.
2. Implement it in `src/web.ts` (`GatewayWeb` class).
3. Implement it in `ios/Sources/GatewayPlugin/GatewayPlugin.swift` with `@objc func <name>(_ call: CAPPluginCall)` and register in `pluginMethods`.
4. Implement it in `android/src/main/java/ai/eliza/plugins/gateway/GatewayPlugin.kt` with `@PluginMethod`.
5. Run `bun run --cwd plugins/plugin-native-gateway build:docs` to regenerate README.

**Add a new event type:**
1. Add the interface to `src/definitions.ts`.
2. Add the `addListener` overload to `GatewayPlugin`.
3. Emit via `this.notifyListeners(eventName, payload)` in all three implementations.

## Conventions / gotchas

- **This is a Capacitor plugin, not an elizaOS runtime plugin.** It does not integrate with `AgentRuntime`, actions, providers, or evaluators. The elizaOS `"elizaos"` field in `package.json` is metadata for platform support, not a runtime hook.
- **No Bonjour/mDNS on web.** `startDiscovery()` and `getDiscoveredGateways()` return empty lists on the browser platform with a status message; only iOS (NWBrowser) and Android (NsdManager) perform real LAN discovery.
- **One active connection per plugin instance.** `connect()` closes any existing WebSocket before opening a new one.
- **Sequence gaps are logged but not fatal.** The web implementation warns on gaps in the `seq` field of event frames; native implementations may differ.
- **iOS minimum deployment target:** iOS 15.0 (Swift 5.9). See `.podspec`.
- **Android dependency:** OkHttp for WebSocket; coroutines (kotlinx.coroutines) for async ops.
- **Build output:** `dist/esm/index.js` (ESM), `dist/plugin.cjs.js` (CJS), `dist/plugin.js` (IIFE for unpkg).
- **`docgen` rewrites README.md.** Running `bun run build:docs` or `bun run docgen` regenerates README from JSDoc in `definitions.ts`. Manual edits to README may be overwritten.
- See root `AGENTS.md` for repo-wide conventions (logger-only, ESM, architecture rules, naming).

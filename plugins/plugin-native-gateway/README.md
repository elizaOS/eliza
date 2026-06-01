# @elizaos/capacitor-gateway

A [Capacitor](https://capacitorjs.com/) plugin that connects an elizaOS app to an **Eliza Gateway** server. Provides service discovery via Bonjour/mDNS, authenticated WebSocket connectivity, RPC request/response, and realtime event streaming — with native implementations on iOS (Swift + NWBrowser), Android (Kotlin + OkHttp + NsdManager), and web (browser WebSocket).

---

## What it does

- **Discovery** — finds Eliza Gateway instances on the local network via Bonjour/mDNS (`_eliza-gw._tcp`). Supports optional wide-area DNS-SD discovery (e.g. via Tailscale). Not available on web.
- **Authenticated connection** — opens a WebSocket to the gateway, sends a `connect` frame with credentials (token or password), and negotiates protocol version 3. Returns session ID, role, scopes, and the methods/events the gateway exposes.
- **RPC** — `Gateway.send({ method, params })` sends a JSON request frame and resolves with the response payload or structured error.
- **Realtime events** — listen to server-pushed events via `addListener("gatewayEvent", ...)`.
- **Connection lifecycle** — state changes (`connecting`, `connected`, `disconnected`, `reconnecting`) and errors are surfaced as typed events. Reconnection uses exponential backoff (800 ms → 15 s).

---

## Platforms

| Platform | Discovery | WebSocket | Notes |
|---|---|---|---|
| iOS | Native Bonjour (NWBrowser) | URLSessionWebSocketTask | Min iOS 15.0 |
| Android | NsdManager | OkHttp | kotlinx.coroutines |
| Web/Node | Not supported | Browser WebSocket | Discovery returns empty list |

---

## Installation

```bash
npm install @elizaos/capacitor-gateway
npx cap sync
```

For iOS, add the pod to your `Podfile`:

```ruby
pod 'ElizaosCapacitorGateway'
```

---

## API

### Import

```typescript
import { Gateway } from '@elizaos/capacitor-gateway';
```

### Discover gateways

```typescript
// Start streaming discovery events
await Gateway.addListener('discovery', (event) => {
  if (event.type === 'found') {
    console.log('Found gateway:', event.gateway.name, event.gateway.host, event.gateway.port);
  }
});

await Gateway.startDiscovery({ timeout: 10000 });

// One-shot snapshot
const { gateways } = await Gateway.getDiscoveredGateways();

await Gateway.stopDiscovery();
```

### Connect

```typescript
const result = await Gateway.connect({
  url: 'wss://192.168.1.42:8080',
  token: 'your-jwt-token',   // or use password: '...'
  clientName: 'my-app',
  role: 'operator',
  scopes: ['operator.admin'],
});

if (result.connected) {
  console.log('Session:', result.sessionId);
  console.log('Role:', result.role);
  console.log('Available methods:', result.methods);
}
```

### Send an RPC request

```typescript
const response = await Gateway.send({
  method: 'agents.list',
  params: {},
});

if (response.ok) {
  console.log(response.payload);
} else {
  console.error(response.error?.code, response.error?.message);
}
```

### Listen for realtime events

```typescript
await Gateway.addListener('gatewayEvent', (event) => {
  console.log(event.event, event.payload, event.seq);
});

await Gateway.addListener('stateChange', (event) => {
  console.log('Connection state:', event.state, event.reason);
});

await Gateway.addListener('error', (event) => {
  console.warn(event.message, 'willRetry:', event.willRetry);
});
```

### Disconnect

```typescript
await Gateway.disconnect();
await Gateway.removeAllListeners();
```

---

## Connection options reference

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | required | WebSocket URL (`ws://` or `wss://`) |
| `token` | `string` | — | JWT / bearer token |
| `password` | `string` | — | Password-based auth |
| `clientName` | `string` | `"eliza-capacitor"` | Client identifier sent in connect frame |
| `clientVersion` | `string` | `"1.0.0"` | Client version string |
| `sessionKey` | `string` | — | Session key for chat sessions |
| `role` | `string` | `"operator"` | Role to request from the gateway |
| `scopes` | `string[]` | `["operator.admin"]` | Scopes to request |

---

## Building

```bash
bun run build        # tsc + rollup → dist/
bun run build:docs   # regenerate README from JSDoc, then build
bun run verify:ios   # pod install + xcodebuild
bun run verify:android  # ./gradlew clean build test
```

> **Note:** `bun run build:docs` regenerates this README from JSDoc comments in `src/definitions.ts`. Manual edits will be overwritten on the next docgen run.

---

## License

MIT — elizaOS

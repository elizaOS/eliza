# @elizaos/capacitor-mobile-agent-bridge

Outbound tunnel from a phone-hosted Eliza agent so a remote Mac client
can reach it. Phone-side companion to the Mac-side
`TunnelToMobileClient` in `@elizaos/app-core`.

This package owns the phone-to-relay tunnel for a phone-hosted Eliza
agent. The JS surface (`startInboundTunnel`, `stopInboundTunnel`,
`getTunnelStatus`, `stateChange` event) is stable. Native implementations
hold an outbound WebSocket to the relay and proxy requests into the same
local agent route surface used by the rest of the mobile app.

## Status

| Platform | Status |
| --- | --- |
| Web    | Fallback. Returns `state: "error"` with an explanatory message. |
| iOS    | Outbound WebSocket tunnel. Proxies path-only requests through the WebView IPC bridge; no listening port is opened. |
| Android | Outbound WebSocket tunnel. Proxies path-only requests into the registered `ElizaAgentService` via reflection; no listening port is opened. |

## Relay frame protocol

Tunnel frames use a path-only HTTP request envelope. The relay never
sends absolute URLs, and the plugin rejects `//host` and scheme-bearing
paths before dispatching to the agent. On iOS, dispatch goes through
`window.__ELIZA_BRIDGE__?.iosLocalAgentRequest`, which is the same Capacitor
IPC bridge the UI uses for full-Bun local mode.

## Usage

```ts
import { MobileAgentBridge } from "@elizaos/capacitor-mobile-agent-bridge";

await MobileAgentBridge.startInboundTunnel({
  relayUrl: "wss://relay.elizacloud.ai/v1/agent-tunnel",
  deviceId: "phone-abc123",
  pairingToken: "...",
});

const status = await MobileAgentBridge.getTunnelStatus();
// { state: "registered" | "error" | ..., relayUrl, deviceId, lastError }

await MobileAgentBridge.stopInboundTunnel();
```

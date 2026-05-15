# @elizaos/capacitor-mobile-agent-bridge

Outbound tunnel from a phone-hosted Eliza agent so a remote Mac client
can reach it. Phone-side companion to the Mac-side
`TunnelToMobileClient` in `@elizaos/app-core`.

This package owns the phone-to-relay tunnel for a phone-hosted Eliza
agent. The JS surface (`startInboundTunnel`, `stopInboundTunnel`,
`getTunnelStatus`, `stateChange` event) is stable, and the native
implementations now hold an outbound WebSocket to the relay. Relay
requests are proxied into the same local agent route surface used by the
rest of the mobile app.

The bridge is a direct/local-only native capability. Apple App Store `ios`
builds omit this tunnel bridge and route foreground local-agent requests through
`ElizaBunRuntime.call({ method: "http_request", args })` IPC. Google Play
`android-cloud` and `android-cloud-debug` builds strip this plugin, the
on-device agent service, and the per-boot local-agent bearer token surface.

## Status

| Platform | Status |
| --- | --- |
| Web    | Stub. Returns `state: "error"` with an explanatory message. |
| iOS    | Direct/local builds only. Outbound WebSocket tunnel that proxies path-only requests through the WebView IPC bridge; no listening port is opened. |
| Android | Sideload/AOSP builds only. Outbound WebSocket tunnel that proxies path-only requests to the token-protected local agent service. |

## Why this exists

iOS apps cannot bind a publicly reachable listening socket. Today the
device-bridge architecture only flows in one direction: phones dial out
to Mac-hosted agents. To support the reverse — a Mac dialing an agent
running on the user's phone — the phone must hold an outbound
connection that a relay (Eliza Cloud) brokers to a matching connection
from the Mac.

Tunnel frames use a path-only HTTP request envelope. The relay never
sends absolute URLs, and the plugin rejects `//host` and scheme-bearing
paths before dispatching to the agent. On iOS, dispatch goes through
`window.__ELIZA_IOS_LOCAL_AGENT_REQUEST__`, which is the same Capacitor
IPC bridge the UI uses for full-Bun local mode. On Android, dispatch is limited
to local loopback bases and injects the per-boot `ElizaAgentService` bearer
token when the caller did not already set `Authorization`.

## Usage

```ts
import { MobileAgentBridge } from "@elizaos/capacitor-mobile-agent-bridge";

await MobileAgentBridge.startInboundTunnel({
  relayUrl: "wss://relay.elizacloud.ai/v1/agent-tunnel",
  deviceId: "phone-abc123",
  pairingToken: "...",
  // Android direct builds may override this with another loopback base.
  // iOS ignores it and uses the in-process IPC path.
  localAgentApiBase: "http://127.0.0.1:31337",
});

const status = await MobileAgentBridge.getTunnelStatus();
// { state: "registered" | "error" | ..., relayUrl, deviceId, localAgentApiBase?, lastError }

await MobileAgentBridge.stopInboundTunnel();
```

# @elizaos/capacitor-mobile-agent-bridge

Outbound tunnel from a phone-hosted Eliza agent so a remote Mac client
can reach it. Phone-side companion to the Mac-side
`TunnelToMobileClient` in `@elizaos/app-core`.

This package is **scaffold-only**. The JS surface
(`startInboundTunnel`, `stopInboundTunnel`, `getTunnelStatus`,
`stateChange` event) is locked here so the runtime can call into the
plugin today, but the iOS and Android transports report
`not_implemented` until the cloud-managed relay or Headscale path
lands. See `docs/reverse-direction-tunneling.md` in the repo root for
the full design and phased plan.

## Status

| Platform | Status |
| --- | --- |
| Web    | Stub. Returns `state: "error"` with an explanatory message. |
| iOS    | Scaffold. Native methods present, transport not yet implemented. |
| Android | Scaffold. Native methods present, transport not yet implemented. |

## Why this exists

iOS apps cannot bind a publicly reachable listening socket. Today the
device-bridge architecture only flows in one direction: phones dial out
to Mac-hosted agents. To support the reverse — a Mac dialing an agent
running on the user's phone — the phone must hold an outbound
connection that a relay (Eliza Cloud) brokers to a matching connection
from the Mac.

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

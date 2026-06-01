# @elizaos/capacitor-mobile-agent-bridge

Capacitor plugin that opens an outbound WebSocket tunnel from a phone-hosted Eliza agent so a remote desktop client can reach it via a relay.

## Purpose / role

iOS and Android apps cannot bind publicly reachable listening sockets. This plugin lets the phone maintain an **outbound** WebSocket to a relay (default: Eliza Cloud managed gateway), which brokers traffic from a paired desktop client to the on-device agent. Relay frames are proxied into the local agent route surface already used by the mobile app — no new inbound port is opened.

This is a Capacitor plugin, not a standard elizaOS runtime plugin. It is registered via `@capacitor/core`'s `registerPlugin` and is consumed by mobile app JS code, not by the agent loader. The web fallback is a stub that always returns `state: "error"`.

## Plugin surface

This is a **Capacitor plugin** — it does not use the elizaOS `Plugin` object or register actions/providers/evaluators. Its surface is a JS API backed by native iOS (Swift) and Android (Kotlin) implementations:

| Method | Description |
|---|---|
| `startInboundTunnel(options)` | Open (or restart) an outbound WebSocket to the relay and register the device. Idempotent. |
| `stopInboundTunnel()` | Close the tunnel and release resources. Safe to call when idle. |
| `getTunnelStatus()` | Return a snapshot of current tunnel state. |
| `addListener("stateChange", fn)` | Subscribe to tunnel state transitions. Returns a `PluginListenerHandle`. |
| `removeAllListeners()` | Unsubscribe all state-change listeners. |

Tunnel states (`MobileAgentTunnelState`): `idle` | `connecting` | `registered` | `disconnected` | `error`

## Layout

```
src/
  index.ts          Plugin entry point. Calls registerPlugin("MobileAgentBridge", { web: loadWeb }).
  definitions.ts    All exported types: MobileAgentBridgePlugin, MobileAgentBridgeStartOptions,
                    MobileAgentTunnelStatus, MobileAgentTunnelState, MobileAgentTunnelStateEvent.
  web.ts            Web/Electrobun stub. startInboundTunnel always resolves to state:"error".

ios/Sources/MobileAgentBridgePlugin/
  MobileAgentBridgePlugin.swift   URLSessionWebSocketTask tunnel + WebView IPC dispatch.

android/src/main/java/ai/eliza/plugins/mobileagentbridge/
  MobileAgentBridgePlugin.kt      OkHttp WebSocket tunnel + dispatch into the registered ElizaAgentService.

ElizaosCapacitorMobileAgentBridge.podspec   CocoaPods spec for iOS native build.
rollup.config.mjs                           Bundles CJS + ESM outputs.
```

## Commands

Only scripts defined in `package.json`:

```bash
bun run --cwd plugins/plugin-native-mobile-agent-bridge build         # clean + tsc + rollup
bun run --cwd plugins/plugin-native-mobile-agent-bridge clean         # remove dist/
bun run --cwd plugins/plugin-native-mobile-agent-bridge watch         # tsc --watch
bun run --cwd plugins/plugin-native-mobile-agent-bridge lint          # biome check
bun run --cwd plugins/plugin-native-mobile-agent-bridge fmt           # biome check --write --unsafe
bun run --cwd plugins/plugin-native-mobile-agent-bridge format        # biome format --write
bun run --cwd plugins/plugin-native-mobile-agent-bridge format:check  # biome format (dry-run)
```

## Config / env vars

Options are passed at call time to `startInboundTunnel`; there are no env vars read by the JS layer.

| Option | Required | Description |
|---|---|---|
| `relayUrl` | Yes | WebSocket URL (`wss://...`) of the relay endpoint. |
| `deviceId` | Yes | Stable identifier reused across app relaunches for persistent pairing. |
| `pairingToken` | No | Pre-shared token for relay authorization without per-frame credentials. |
| `localAgentApiBase` | No | Override for the on-device agent base. Defaults to `eliza-local-agent://ipc` (Android) or in-process ITTP/Bun IPC (iOS). |

## How to extend

**Add a new method to the plugin surface:**
1. Declare the method signature in `src/definitions.ts` on `MobileAgentBridgePlugin`.
2. Implement it in `src/web.ts` (the web stub).
3. Implement it in `ios/Sources/MobileAgentBridgePlugin/MobileAgentBridgePlugin.swift`.
4. Implement it in `android/src/main/java/ai/eliza/plugins/mobileagentbridge/MobileAgentBridgePlugin.kt`.
5. Run `bun run build` to regenerate the dist outputs.

**Add a new event type:**
Add the event name as a string literal parameter to `addListener` in `definitions.ts`, emit it in native code via the standard Capacitor `notifyListeners` mechanism, and call `this.notifyListeners(...)` in the web stub where appropriate.

## Conventions / gotchas

- **Capacitor, not elizaOS runtime plugin.** This package is consumed by Capacitor mobile apps, not loaded by the elizaOS agent loader. Do not add elizaOS `Plugin` objects, actions, or providers here.
- **Web stub always errors.** `startInboundTunnel` on the web implementation always resolves with `state: "error"`. This is intentional — do not make it a silent no-op.
- **Path-only relay frames.** The relay never sends absolute URLs. Native implementations reject `//host` and scheme-bearing paths before dispatching to the agent.
- **iOS dispatch path.** On iOS, proxied requests go through `window.__ELIZA_IOS_LOCAL_AGENT_REQUEST__` — the same Capacitor IPC bridge the UI uses for full-Bun local mode.
- **Build outputs.** `dist/plugin.cjs.js` (CJS), `dist/esm/index.js` (ESM), and `dist/plugin.js` (unpkg bundle) are all generated by `rollup -c rollup.config.mjs` after `tsc`. Do not hand-edit dist files.
- **CocoaPods name.** The iOS pod is `ElizaosCapacitorMobileAgentBridge` (see the `.podspec` and `package.json` `capacitor.ios.podName`).
- For repo-wide rules (logger, ESM, architecture layers, naming), see the root `AGENTS.md`.

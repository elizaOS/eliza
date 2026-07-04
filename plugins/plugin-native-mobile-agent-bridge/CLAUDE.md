# @elizaos/capacitor-mobile-agent-bridge

Capacitor plugin that opens an outbound WebSocket tunnel from a phone-hosted Eliza agent so a remote desktop client can reach it via a relay.

## Purpose / role

iOS and Android apps cannot bind publicly reachable listening sockets. This plugin lets the phone maintain an **outbound** WebSocket to a relay (default: Eliza Cloud managed gateway), which brokers traffic from a paired desktop client to the on-device agent. Relay frames are proxied into the local agent route surface already used by the mobile app — no new inbound port is opened.

This is a Capacitor plugin, not a standard elizaOS runtime plugin. It is registered via `@capacitor/core`'s `registerPlugin` and is consumed by mobile app JS code, not by the agent loader. The web fallback always returns `state: "error"`.

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
  web.ts            Web/Electrobun fallback. startInboundTunnel resolves to state:"error" for valid
                    inputs; throws for invalid relayUrl or deviceId.
  web.test.ts       Unit tests for the web fallback implementation.

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
bun run --cwd plugins/plugin-native-mobile-agent-bridge test          # vitest run
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
2. Implement it in `src/web.ts` (the web fallback).
3. Implement it in `ios/Sources/MobileAgentBridgePlugin/MobileAgentBridgePlugin.swift`.
4. Implement it in `android/src/main/java/ai/eliza/plugins/mobileagentbridge/MobileAgentBridgePlugin.kt`.
5. Run `bun run build` to regenerate the dist outputs.

**Add a new event type:**
Add the event name as a string literal parameter to `addListener` in `definitions.ts`, emit it in native code via the standard Capacitor `notifyListeners` mechanism, and call `this.notifyListeners(...)` in the web fallback where appropriate.

## Conventions / gotchas

- **Capacitor, not elizaOS runtime plugin.** This package is consumed by Capacitor mobile apps, not loaded by the elizaOS agent loader. Do not add elizaOS `Plugin` objects, actions, or providers here.
- **Web fallback errors on valid input; throws on invalid input.** `startInboundTunnel` on the web implementation validates `relayUrl` (must be a valid ws/wss/http/https URL, no embedded credentials) and `deviceId` (alphanumeric, max 128 chars) — invalid inputs throw. Valid inputs resolve with `state: "error"`. Do not make it a silent success.
- **Path-only relay frames.** The relay never sends absolute URLs. Native implementations reject `//host` and scheme-bearing paths before dispatching to the agent.
- **iOS dispatch path.** On iOS, proxied requests go through `window.__ELIZA_BRIDGE__?.iosLocalAgentRequest` — the same Capacitor IPC bridge the UI uses for full-Bun local mode.
- **Build outputs.** `dist/plugin.cjs.js` (CJS), `dist/esm/index.js` (ESM), and `dist/plugin.js` (unpkg bundle) are all generated by `rollup -c rollup.config.mjs` after `tsc`. Do not hand-edit dist files.
- **CocoaPods name.** The iOS pod is `ElizaosCapacitorMobileAgentBridge` (see the `.podspec` and `package.json` `capacitor.ios.podName`).
- For repo-wide rules (logger, ESM, architecture layers, naming), see the root `AGENTS.md`.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->

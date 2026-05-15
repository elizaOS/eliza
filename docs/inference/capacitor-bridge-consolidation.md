# Capacitor WebSocket Bridge — Consolidation Design Doc

Status: planning / research. No implementation yet.

This doc covers the migration path for eliminating (or shrinking) the
WebSocket loopback bridge between the Bun agent process and the
Capacitor WebView on stock Android builds.

## 1. Current state

### 1.1 Runtime topology on stock-Android Capacitor

Stock Android builds run **two separate OS processes**:

1. **Java host process** (`MainActivity`, `BridgeActivity`) — owns the
   Capacitor WebView and the native `llama-cpp-capacitor` plugin.
   - `packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/MainActivity.java:63`
     constructs the WebView via Capacitor's `BridgeActivity.super.onCreate`.
   - `packages/app-core/platforms/android/app/src/main/AndroidManifest.xml:16`
     declares `MainActivity` as the launcher activity.

2. **Bun agent process** — forked from `ElizaAgentService` via
   `ProcessBuilder` running `launch.sh`, which does a `setsid` double-fork.
   - `packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java:40`
     "Foreground service that owns the local Eliza agent process".
   - `ElizaAgentService.java:763-789` builds the env + invokes
     `/system/bin/sh launch.sh` with `bun agent-bundle.js`.
   - `AndroidManifest.xml:47` declares it as `foregroundServiceType="specialUse"`
     `local-agent-runtime`.

The Bun process and the WebView are **separate Linux processes** in the
same UID sandbox. They cannot share a JS realm. The agent's HTTP server
binds `127.0.0.1` (`ElizaAgentService.java:793` —
`ELIZA_API_BIND=127.0.0.1`) and the WebView reaches it over loopback.

For comparison: iOS uses a single-realm model. The iOS agent bundle is
loaded into a `JSContext` hosted by the Capacitor Bridge, so
`window.Capacitor.Plugins.LlamaStreaming` is reachable from the agent's
JS — see `plugins/plugin-local-inference/src/services/ios-llama-streaming.ts:17-26`
for the constraint explanation. AOSP runs llama.cpp inside the agent
via `bun:ffi`
(`plugins/plugin-aosp-local-inference/src/aosp-llama-adapter.ts`).

### 1.2 What crosses the WebSocket

Defined at `plugins/plugin-capacitor-bridge/src/mobile-device-bridge-bootstrap.ts:38`
(`DEVICE_BRIDGE_PATH = "/api/local-inference/device-bridge"`). The wire
contract is the union of `AgentOutbound` (line 203) and `DeviceOutbound`
(line 157):

| Direction | Type | Notes |
| -- | -- | -- |
| Agent → Device | `load` | Model load with full GGUF path + context size + speculative-decode knobs. |
| Agent → Device | `unload` | Free the loaded model. |
| Agent → Device | `generate` | Single full-turn completion request. Returns one `generateResult` per request — **not** token-streamed over the WS**. |
| Agent → Device | `embed` | Embedding request, returns one float vector per request. |
| Agent → Device | `formatChat` | Apply the model's native Jinja chat template via `LlamaCpp.getFormattedChat()`. |
| Agent → Device | `ping` | 15s heartbeat (JSON frame, line 435–442). |
| Device → Agent | `register` | First frame after connect; ships `DeviceCapabilities`. |
| Device → Agent | `loadResult` / `unloadResult` / `generateResult` / `embedResult` / `formatChatResult` | Correlation-id matched responses. |
| Device → Agent | `pong` | Heartbeat reply. |

Per-turn from the agent's `makeGenerateHandler` path
(`mobile-device-bridge-bootstrap.ts:1001-1042`):

1. `loadModel` round-trip (only when the model is not already loaded —
   short-circuited at line 568: `if (device?.loadedPath === args.modelPath) return`).
2. `formatChat` round-trip (line 1027) — called every turn.
3. `generate` round-trip (line 1035) — one request, one response.

Per-turn message count when steady-state (model already loaded):
**2 round-trips, ~4 frames**. The native plugin handles streaming
internally; the agent only sees the final text.

### 1.3 Wire-format envelope

Pure JSON over `ws://127.0.0.1:<agent-port>/api/local-inference/device-bridge?token=<pairing>`.
- Auth: `?token=` query param + `pairingToken` field in the `register`
  frame, both checked against `ELIZA_DEVICE_PAIRING_TOKEN` env
  (`mobile-device-bridge-bootstrap.ts:290-293`).
- Per-boot token rotation: `ElizaAgentService.java:746-755` regenerates
  the token on every agent boot and writes it where the Capacitor agent
  plugin can read it (`localAgentToken()`).
- `maxPayload: 1024 * 1024` (1 MB) — caps embedding frames
  (`mobile-device-bridge-bootstrap.ts:331`).

### 1.4 Device-side client

Lives in `packages/native-plugins/llama/src/device-bridge-client.ts`.
That file is loaded into the WebView's JS, dials the agent over WS, and
routes inbound requests into the Capacitor `llama-cpp-capacitor` plugin
via `loadCapacitorLlama()`. The WebView is the **only** caller of the
native plugin — the agent never talks to `llama-cpp-capacitor` directly,
because the agent's process can't.

## 2. Why the WebSocket exists

The agent's JS realm lives in a different OS process from the WebView's
JS realm. The native `llama-cpp-capacitor` plugin is bound to the
WebView's process (it's a Capacitor plugin, registered on the
`Bridge` instance owned by `MainActivity`). The agent therefore needs
**some** form of cross-process IPC to invoke it.

WebSocket was chosen because:
- The agent already runs an HTTP server (`hono`) on loopback for the UI.
- WebSocket upgrades on that same server cost zero new ports / no new
  permissions.
- The agent's JS already speaks `ws` (npm) — no native bridge needed on
  the agent side.
- Capacitor's plugin invocation model is already async/Promise, so the
  device side maps cleanly onto WS request/response with correlation
  ids.

This is the same reason the duplicate (multi-device, desktop-capable)
implementation at `packages/ui/src/services/local-inference/device-bridge.ts`
uses WebSocket: the broader "agent on a VPS, device on a phone" topology
requires IPC across machine boundaries anyway, so WS subsumes both.

## 3. Migration options

### Option A — Embed Bun inside the Capacitor activity (single process)

Run Bun in-process with `MainActivity`. The Capacitor `Bridge` and the
agent share a process, and Capacitor plugins are reachable from the
agent via `globalThis.Capacitor.Plugins.LlamaCpp`. WS bridge deletes
entirely.

**How:**
- Build a JNI/NDK wrapper that links `libbun` into the app's `.so` set
  (similar to how iOS embeds `ElizaBunEngine.xcframework`).
- Boot Bun on a worker thread from `MainActivity.onCreate`.
- Expose `Capacitor.Plugins` to the embedded Bun's JS realm via a JS
  context bridge — either by sharing the WebView's V8/Blink isolate
  (impossible: WebView is OS-managed Chromium), or by running Bun in
  the same V8 isolate as the WebView (also impossible: WebView is a
  separate Chromium renderer process, not embeddable JSC/V8).

**Verdict:** **Not viable** on Android without abandoning Capacitor's
WebView model. The Android `WebView` is a system component backed by a
separate `WebView`-renderer process; you cannot put your own native code
inside its JS realm the way iOS lets you with `JSContext`. The agent
and the WebView's JS would still be in different processes.

A real version of this would replace Capacitor's `WebView` with
Tauri/Wry, Electrobun, or a custom JSC host — i.e. **the AOSP topology**
that already exists in `plugin-aosp-local-inference`. AOSP is the
"option A done correctly" path.

Effort estimate: 10–25 person-days, only worthwhile if we're committed
to dropping `WebView` entirely.
Risk: very high (Play Store reach, accessibility, web-content rendering,
file pickers all break).

### Option B — Direct Capacitor plugin invoke from in-WebView JS (the iOS approach)

The iOS path works because the agent's JS **runs inside the Capacitor
WebView's JS realm** (via `JSContext` embedded in the Bridge). On
Android, the agent does **not** run there — it's in a separate Bun
process. So Option B is not actually available on Android today.

To make it available, we'd need to run the agent's JS inside the
WebView. That means either:
- Ship the agent bundle as `<script>` inside the WebView and drop Bun.
  Kills `bun:ffi`, kills `node:fs`, kills the Hono server, kills PGlite
  (which needs `fs`), kills every plugin that touches native APIs. The
  agent stops being an "agent" and becomes a frontend.
- Run a *second* WebView with `addJavascriptInterface` for filesystem
  access and use Capacitor's `Bridge.eval()` to invoke plugins. This is
  essentially "WebView calling WebView" — same constraints as Option C
  with extra overhead.

**Verdict:** **Not viable** as stated. Conflates the runtime
architectures of iOS and Android.

Effort estimate: would require the entire mobile-bundle pipeline
rewrite. 20+ person-days. Not recommended.

### Option C — Use Capacitor's `Bridge.evaluateJavascript` instead of WebSocket

Capacitor's Android `Bridge` exposes `evaluateJavascript(String)` to
inject JS into the WebView and receive a stringified return value via
the result callback. The agent's Bun process could call **down to Java
via JNI** to invoke this, replacing the WS frames with direct Java
calls.

**Practical shape:**
1. Add a JNI method `evalInWebView(String script, Callback cb)` on the
   `ElizaAgentService` side that calls
   `bridge.getActivity().runOnUiThread(() -> bridge.eval(script, cb))`.
2. From Bun, call that JNI method via `bun:ffi` (Android Bun supports
   `dlopen` of `.so` files in the agent's `nativeLibraryDir`).
3. The JS injected into the WebView calls
   `Capacitor.Plugins.LlamaCpp.completion(...)` directly and posts the
   result back via a JNI callback.

**Why this is worse than what we have:**
- `evaluateJavascript` runs **per call from the UI thread**. The
  agent's inference path is not on the UI thread. Marshalling every
  generate through the Android main looper risks input latency.
- The callback returns a `String`, so every reply is still serialized
  JSON — same overhead as the WS frame.
- We'd need a JNI bridge from Bun's Android port to the Java `Bridge`
  instance — that requires a new native-plugins package and a
  Capacitor plugin shim to grab a stable handle to the `Bridge`.
- We'd replace one transport (`ws://127.0.0.1`) with two transports
  (JNI + `evaluateJavascript`) that have to be maintained.

**Verdict:** Architecturally cleaner than (A)/(B) but **not a win** in
practice. The WS loopback in the kernel is already a zero-copy fast
path; `evaluateJavascript` adds a UI-thread hop. Reject.

Effort estimate: 5–8 person-days for a working prototype, but no
expected performance or maintenance gain.

### Option D — Keep WS, optimize message density / batching

The current 2-round-trip-per-turn path is already lean. The optimizations
worth considering:

| Optimization | Estimated savings | Risk |
| -- | -- | -- |
| Cache `formatChat` results per `(modelPath, messages-hash)` so identical history is templated once. | 1 round-trip per turn when the user re-submits without history changes. Edge case. | Low — cache scoped to current process; invalidate on `unload`. |
| Use binary frames for embeddings instead of JSON-of-floats. A 1024-dim Float32 embedding is 4 KB binary vs ~12 KB JSON. | 60-70% bandwidth on embedding calls; small CPU win. | Medium — needs matched encode/decode on both sides. |
| Use the WS protocol's built-in ping (`Sec-WebSocket-Frame` opcode `0x9`) instead of JSON `{type:"ping"}`. | Trivial CPU + ~30 bytes/15s. | Low — `ws` supports `ws.ping()`. |
| Merge `load` into the first `generate` request when the model isn't loaded yet. | 1 round-trip on first turn after boot. | Low — only on cold path. |
| Drop `formatChat` round-trip when the model has no Jinja template baked in (already handled — see `mobile-device-bridge-bootstrap.ts:1024-1033`). | n/a — already done. | n/a |

None of these are "obviously safe to ship without testing" because they
all change wire contract. They are *low risk to implement* but require
the matched change in
`packages/native-plugins/llama/src/device-bridge-client.ts`.

Effort estimate: 1–3 person-days for the full set (including tests).

## 4. Recommendation

**Option D, scoped.** Specifically:

1. Implement **binary-frame embeddings** — biggest payload reduction
   for the only message that approaches the 1 MB cap. ~1 person-day
   including matched device-side change and tests.
2. Implement **`formatChat` cache** — last template result kept per
   loaded model, keyed by message-list hash. Invalidate on
   `loadModel(args)` with a different `modelPath`. ~0.5 person-day.
3. Skip `evaluateJavascript`/JNI experiments. They don't help.

Do **not** pursue Options A, B, or C. They either misread the iOS
architecture (B), require dropping Capacitor (A), or add complexity
without measurable benefit (C).

For the long term, the right architectural play is **AOSP**. AOSP
already runs llama.cpp in the agent process via `bun:ffi` — same
benefits Option A claims, without fighting Android's WebView model.
Steer new mobile work toward AOSP where the user has the freedom to
install it. Keep the stock-Android WebSocket path because Play Store
distribution requires the stock-Capacitor topology.

## 5. Low-risk wins identified today

These are concrete improvements available **without** any architectural
change. Listed for follow-up — none implemented in this pass per the
task's scoping.

1. **Binary-frame embeddings** —
   `plugins/plugin-capacitor-bridge/src/mobile-device-bridge-bootstrap.ts:619-630`
   (`embed`) and the device-side counterpart at
   `packages/native-plugins/llama/src/device-bridge-client.ts` decode
   embedding frames as JSON-of-floats. Replace with `Float32Array`
   serialized over a binary WS frame. Drops bandwidth ~3×, drops
   `JSON.parse` cost on the hot path.

2. **`formatChat` per-model cache** —
   `plugins/plugin-capacitor-bridge/src/mobile-device-bridge-bootstrap.ts:1023-1034`
   calls `formatChat` every turn. The result is a pure function of
   `(loaded model, messages)`. Cache last-N results per model; invalidate
   on `loadModel` with a new `modelPath`.

3. **WS-protocol heartbeats** —
   `plugins/plugin-capacitor-bridge/src/mobile-device-bridge-bootstrap.ts:435-442`
   sends JSON `{type:"ping"}` every 15 s. Replace with
   `socket.ping()` / `socket.pong()` (RFC 6455 control frames). Removes
   ~30 bytes/15 s and a JSON parse on the device side.

4. **Cold-path `load`+`generate` coalescing** — Bundle `load` into the
   first `generate` request when no model is loaded. Saves one round
   trip on first turn after boot.
   `plugins/plugin-capacitor-bridge/src/mobile-device-bridge-bootstrap.ts:566-579`
   handles `loadModel`; `generate` (line 595) currently assumes load
   already happened.

5. **Overlapping device-bridge implementations** — There are two
   independent agent-side bridge servers handling the same wire
   contract:
   - `plugins/plugin-capacitor-bridge/src/mobile-device-bridge-bootstrap.ts`
   - `packages/ui/src/services/local-inference/device-bridge.ts`
     (1070+ lines, multi-device routing, persistence).
   The Capacitor plugin variant is a Capacitor-specific subset of the
   `packages/ui` variant. Either delete one or document why both exist.
   This is **not a low-risk** change — listed here so it isn't lost.

## 6. References

- Plugin source: `plugins/plugin-capacitor-bridge/src/mobile-device-bridge-bootstrap.ts`
- Plugin entry: `plugins/plugin-capacitor-bridge/src/index.ts`
- Device-side client: `packages/native-plugins/llama/src/device-bridge-client.ts`
- Android agent host: `packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java`
- Android activity host: `packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/MainActivity.java`
- Android manifest: `packages/app-core/platforms/android/app/src/main/AndroidManifest.xml`
- iOS LlamaStreaming (single-realm contrast): `plugins/plugin-local-inference/src/services/ios-llama-streaming.ts`
- AOSP in-process llama (no bridge): `plugins/plugin-aosp-local-inference/src/aosp-llama-adapter.ts`
- Mobile bundle build (target=android|ios|ios-jsc): `packages/agent/scripts/build-mobile-bundle.mjs`
- Sibling multi-device bridge: `packages/ui/src/services/local-inference/device-bridge.ts`

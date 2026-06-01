# @elizaos/plugin-capacitor-bridge

Agent-side bridge that enables stock iOS and Android Eliza builds to run local GGUF inference through the device's native Capacitor llama.cpp plugin.

## What it does

AOSP builds run llama.cpp directly inside the agent process via `bun:ffi`. Stock Capacitor builds (App Store iOS, standard Android APK) cannot do that — llama.cpp is exposed to the WebView through a native Capacitor plugin instead. This package is the agent-side half of that path:

- **Android**: accepts a loopback WebSocket from the Capacitor WebView, delegates `TEXT_SMALL`, `TEXT_LARGE`, and `TEXT_EMBEDDING` model requests to the connected device, and lets the normal elizaOS model-handler system work unchanged.
- **iOS**: runs the elizaOS runtime inside the Bun binary bundled into the iOS app and dispatches API calls in-process over native Bun host IPC (no HTTP loopback).

Both paths install a sandboxed virtual filesystem (`installMobileFsShim`) that confines all `node:fs` operations to the app's writable workspace directory, enforcing App Store and Play Store code-execution policies.

## Capabilities added

- `TEXT_SMALL` model handler — routes to the connected Capacitor device.
- `TEXT_LARGE` model handler — routes to the connected Capacitor device.
- `TEXT_EMBEDDING` model handler — routes to the connected Capacitor device.
- Automatic GGUF model download from `elizaos/eliza-1` on HuggingFace when no local model is found (unless `ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD=1`).
- WebSocket endpoint `/api/local-inference/device-bridge` for Capacitor WebView registration and inference RPC.

## Installation

This package is used by the elizaOS agent bundle. It is not a standard elizaOS plugin and cannot be added to `character.plugins`. The agent bundle entry point imports and calls its bootstrap functions directly.

```
@elizaos/plugin-capacitor-bridge
```

## Configuration

### Android (WebSocket device bridge)

| Env var | Required | Description |
|---|---|---|
| `ELIZA_DEVICE_BRIDGE_ENABLED=1` | Yes | Enables the WebSocket bridge. |
| `ELIZA_DEVICE_PAIRING_TOKEN` | Yes | Shared secret — must match the token sent by the Capacitor WebView. |
| `ELIZA_DEVICE_BRIDGE_TOKEN` | Alias | Fallback for `ELIZA_DEVICE_PAIRING_TOKEN`. |

### Model path (both platforms)

| Env var | Description |
|---|---|
| `ELIZA_LOCAL_CHAT_MODEL_PATH` | Absolute path to a GGUF for chat (TEXT_SMALL / TEXT_LARGE). |
| `ELIZA_LOCAL_EMBEDDING_MODEL_PATH` | Absolute path to an embedding GGUF. |
| `ELIZA_LOCAL_MODEL_PATH` | Fallback when neither slot-specific var is set. |
| `ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD=1` | Disables auto-download from HuggingFace. |

If no model path is set and auto-download is enabled, the bridge downloads recommended eliza-1 GGUFs from `elizaos/eliza-1` on HuggingFace into `$ELIZA_STATE_DIR/local-inference/models/`.

### Timeouts (all optional, default 600000 ms)

- `ELIZA_DEVICE_LOAD_TIMEOUT_MS`
- `ELIZA_DEVICE_GENERATE_TIMEOUT_MS`
- `ELIZA_DEVICE_EMBED_TIMEOUT_MS`

## Filesystem sandbox

Both platforms install a deny-by-default `node:fs` interceptor (`installMobileFsShim`) before booting the runtime:

- All paths are resolved relative to the app's writable workspace root (`MOBILE_WORKSPACE_ROOT` on iOS, `HOME` on Android).
- Path traversal outside the root throws `EACCES`.
- System directories (`/etc`, `/usr`, `/System`, `/proc`, etc.) are blocked unconditionally.
- Writes to native binary extensions (`.so`, `.dylib`, `.node`) are blocked.
- `require()` of file paths is blocked — all code must be bundled.

## WebSocket protocol (Android)

The Capacitor WebView connects to `ws://127.0.0.1:<port>/api/local-inference/device-bridge?token=<ELIZA_DEVICE_PAIRING_TOKEN>`.

Connection flow:
1. WebView sends `{ type: "register", payload: { deviceId, pairingToken, capabilities, loadedPath } }`.
2. Agent sends `{ type: "load", correlationId, modelPath, ... }` → device replies `{ type: "loadResult", correlationId, ok, loadedPath }`.
3. Agent sends `{ type: "generate", correlationId, prompt, ... }` → device replies `{ type: "generateResult", correlationId, ok, text }`.
4. Agent sends `{ type: "embed", correlationId, input }` → device replies `{ type: "embedResult", correlationId, ok, embedding }`.
5. Agent sends `{ type: "formatChat", correlationId, messages }` → device replies `{ type: "formatChatResult", correlationId, ok, prompt }` (invokes native Jinja chat template).
6. Agent pings every 15 s; device replies `{ type: "pong" }`.

Note: iOS connections are rejected with close code `4003`. iOS uses native IPC, not this WebSocket path.

## Recommended default models

| Slot | Model ID | HuggingFace path |
|---|---|---|
| TEXT_SMALL | `eliza-1-0_8b` | `elizaos/eliza-1` — `bundles/0_8b/text/eliza-1-0_8b-128k.gguf` |
| TEXT_LARGE | `eliza-1-2b` | `elizaos/eliza-1` — `bundles/2b/text/eliza-1-2b-128k.gguf` |
| TEXT_EMBEDDING | `eliza-1-embedding` | `elizaos/eliza-1` — `bundles/4b/embedding/eliza-1-embedding.gguf` |

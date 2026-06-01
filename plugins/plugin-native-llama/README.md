# @elizaos/capacitor-llama

Mobile llama.cpp adapter for elizaOS. A thin wrapper over
[`llama-cpp-capacitor`](https://github.com/arusatech/annadata-llama-cpp) that
maps its contextId-based API onto elizaOS's `LocalInferenceLoader` contract,
so the standard `ActiveModelCoordinator` in `@elizaos/app-core` can switch
between the desktop (node-llama-cpp) engine and mobile native inference
transparently.

## What it does

- Registers as the runtime's `localInferenceLoader` service during the
  Capacitor bootstrap via `registerCapacitorLlamaLoader(runtime)`.
- Maps `load({ modelPath })` → `initContext` (one native context per adapter
  instance; chat and embedding run on separate instances to avoid context
  collisions).
- Maps `unload()` → `releaseContext`.
- Exposes `generate()` and `generateStream()` that target the chat model, and
  `embed()` that targets a separate embedding-model context.
- Applies the loaded GGUF's native chat template via `formatChat()` (backed
  by `llama_chat_apply_template`).
- Fans the native `@LlamaCpp_onToken` stream out to elizaOS token listeners.
- Provides `DeviceBridgeClient` — a WebSocket relay that lets an agent
  container reach a paired mobile device for inference (load, generate, embed,
  formatChat over a JSON RPC protocol).
- Provides `serializeTokenTree` / `deserializeTokenTree` — binary codec for
  the native speculative-decode sampler-hook wire format.

## What it does not do

- It does not ship llama.cpp native binaries — `llama-cpp-capacitor`
  handles iOS (arm64 + x86_64 with Metal) and Android (arm64-v8a,
  armeabi-v7a, x86, x86_64) itself.
- It does not run on web. On Electrobun / Vite the desktop agent uses the
  standalone `node-llama-cpp` engine in `@elizaos/app-core`.
- It does not export an elizaOS `Plugin` object; it is wired manually via
  `registerCapacitorLlamaLoader`.

## Setup in apps/app

1. Install the dependency (already declared here):

   ```bash
   bun install
   ```

2. Register the loader during Capacitor bootstrap (in the runtime init path
   that owns the mobile `AgentRuntime`):

   ```ts
   import { registerCapacitorLlamaLoader } from "@elizaos/capacitor-llama";

   // After runtime boot, before the Model Hub is mounted:
   registerCapacitorLlamaLoader(runtime);
   ```

3. Run `bunx cap sync` in `apps/app` to pick up the native plugin. iOS and
   Android builds will pull in `llama-cpp-capacitor`'s prebuilt native
   libraries automatically.

## Configuration

| Env var | Description |
|---------|-------------|
| `ELIZA_LLAMA_CACHE_TYPE_K` | KV-cache key type — `f16`, `tbq3_0`, `tbq4_0`. Requires the buun-llama-cpp fork for non-`f16` values. |
| `ELIZA_LLAMA_CACHE_TYPE_V` | KV-cache value type — same values. |

Explicit `cacheTypeK`/`cacheTypeV` fields on `LoadOptions` take precedence over env vars.

## Scope notes

- Only **one model is loaded per adapter role** at a time. `load()` disposes
  the previous context for that adapter before reinitializing, so VRAM is
  never double-allocated.
- GGUF files are downloaded to the app sandbox by the `@elizaos/app-core`
  downloader (shared with desktop). The mobile UI filters the catalog to
  small/tiny models only.
- Streaming tokens flow over Capacitor's native event bus
  (`@LlamaCpp_onToken`). Subscribe via `capacitorLlama.onToken(listener)`.
- The `buun-llama-cpp` fork exposes optional `setCacheType`, `setSpecType`,
  and `getNativeKernels` bridge methods for TurboQuant KV caches and MTP
  speculative decoding. Stock builds warn-and-no-op on those calls.

## Licensing

MIT — matches `llama-cpp-capacitor` and llama.cpp upstream.

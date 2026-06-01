# @elizaos/capacitor-llama

Mobile llama.cpp adapter for elizaOS. A thin wrapper over
[`llama-cpp-capacitor`](https://github.com/arusatech/annadata-llama-cpp) that
maps its contextId-based API onto elizaOS's `LocalInferenceLoader` contract,
so the `ActiveModelCoordinator` in `@elizaos/ui`
(`src/services/local-inference/`) can switch between the desktop
(node-llama-cpp) engine and mobile native inference transparently.

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
  standalone `node-llama-cpp` engine (`LocalInferenceEngine` in
  `@elizaos/ui`, `src/services/local-inference/engine.ts`).
- It does not export an elizaOS `Plugin` object; it is wired manually via
  `registerCapacitorLlamaLoader`.

## Consumption

This package is consumed by `@elizaos/ui` in
`src/api/ios-local-agent-kernel.ts`, which dynamically imports
`@elizaos/capacitor-llama` and uses the `capacitorLlama` singleton for the
mobile local-agent kernel. The Capacitor app shell lives in `packages/app`
(its `package.json` declares the `llama-cpp-capacitor` native dependency).

Two ways to wire the adapter into a runtime:

- **`registerCapacitorLlamaLoader(runtime)`** — registers a
  `localInferenceLoader` service backed by separate chat and embedding adapter
  instances. Call it during the mobile runtime bootstrap, in the init path that
  owns the mobile `AgentRuntime`:

  ```ts
  import { registerCapacitorLlamaLoader } from "@elizaos/capacitor-llama";

  registerCapacitorLlamaLoader(runtime);
  ```

- **`capacitorLlama`** — the default singleton `LlamaAdapter`, used directly by
  callers that don't need per-role context separation.

After adding native code, run `bunx cap sync` in `packages/app` to pick up the
native plugin. iOS and Android builds pull in `llama-cpp-capacitor`'s prebuilt
native libraries automatically.

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
- GGUF files are downloaded to the app sandbox by the `@elizaos/ui`
  downloader (`src/services/local-inference/downloader.ts`, shared with
  desktop). The mobile UI filters the catalog to small/tiny models only.
- Streaming tokens flow over Capacitor's native event bus
  (`@LlamaCpp_onToken`). Subscribe via `capacitorLlama.onToken(listener)`.
- The `buun-llama-cpp` fork exposes optional `setCacheType`, `setSpecType`,
  and `getNativeKernels` bridge methods for TurboQuant KV caches and MTP
  speculative decoding. Stock builds warn-and-no-op on those calls.


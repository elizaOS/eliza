# @elizaos/capacitor-llama

Mobile llama.cpp adapter for Eliza. A **thin wrapper** over
[`llama-cpp-capacitor`](https://github.com/arusatech/annadata-llama-cpp) that
maps its contextId-based API onto Eliza's `LocalInferenceLoader` contract,
so the standard `ActiveModelCoordinator` in `@elizaos/app-core` can switch
between the desktop (node-llama-cpp) engine and mobile native inference
transparently.

## What it does

- Registers as the runtime's `localInferenceLoader` service during the
  Capacitor bootstrap.
- Maps `loadModel({ modelPath })` → `initContext`.
- Maps `unloadModel()` → `releaseContext` / `releaseAllContexts`.
- Exposes a `generate()` surface matching the desktop engine.
- Fans the native `@LlamaCpp_onToken` stream out to Eliza's token listeners.

## What it does not do

- It does not ship llama.cpp native binaries — `llama-cpp-capacitor`
  handles iOS (arm64 + x86_64 with Metal) and Android (arm64-v8a,
  armeabi-v7a, x86, x86_64) itself.
- It does not run on web. On Electrobun / Vite we fall back to the
  standalone `node-llama-cpp` engine in `@elizaos/app-core`.

## Setup in apps/app

1. Install the dependency (already declared here):

   ```bash
   bun install
   ```

2. Register the loader during Capacitor bootstrap. In `apps/app`'s
   Capacitor init path (currently in `src/capacitor-shell.ts` or the
   runtime bootstrap that owns the mobile `AgentRuntime`):

   ```ts
   import { registerCapacitorLlamaLoader } from "@elizaos/capacitor-llama";

   // After runtime boot, before the Model Hub is mounted:
   registerCapacitorLlamaLoader(runtime);
   ```

3. Run `bunx cap sync` in `apps/app` to pick up the native plugin. iOS and
   Android builds will pull in `llama-cpp-capacitor`'s prebuilt native
   libraries automatically.

## Scope notes

- Only **one model is loaded at a time**. `load()` disposes the previous
  context first so we never double-allocate VRAM on device.
- GGUF files are downloaded to the app sandbox by the
  `@elizaos/app-core` downloader (shared with desktop). The mobile UI
  filters the catalog to small/tiny bucket models only, since anything
  larger won't realistically run on a phone.
- Streaming tokens flow over Capacitor's native event bus
  (`@LlamaCpp_onToken`). Subscribe via `capacitorLlama.onToken(listener)`.
- For a full desktop-level feature set (embeddings, reranking, chat
  templates, tool calling), read the upstream
  [`llama-cpp-capacitor` README](https://github.com/arusatech/annadata-llama-cpp).
  This adapter only wires the minimal slice needed for Eliza's agent
  runtime; extend it as the mobile product grows.

## Licensing

MIT — matches `llama-cpp-capacitor` and llama.cpp upstream.

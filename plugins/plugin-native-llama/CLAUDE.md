# @elizaos/capacitor-llama

Mobile llama.cpp adapter — maps `llama-cpp-capacitor`'s contextId-based API onto elizaOS's `LocalInferenceLoader` contract for iOS and Android native inference.

## Purpose / role

This package is the mobile-side adapter that lets an Eliza agent run GGUF models locally on iOS and Android using the [`llama-cpp-capacitor`](https://github.com/arusatech/annadata-llama-cpp) Capacitor plugin. It is **not** a standard elizaOS `Plugin` object with registered actions/providers/evaluators — it is a low-level adapter library. Integration is opt-in: call `registerCapacitorLlamaLoader(runtime)` during the Capacitor mobile bootstrap to wire this as the runtime's `localInferenceLoader` service. On web it is unavailable (throws on `load()`).

## Plugin surface

This package does not register elizaOS actions, providers, evaluators, or routes. It exposes:

- **`CapacitorLlamaAdapter`** — class implementing `LlamaAdapter`. One instance per native context (chat and embedding run as separate instances). Core methods: `load`, `unload`, `generate`, `generateStream`, `embed`, `formatChat`, `getHardwareInfo`, `cancelGenerate`, `setCacheType`, `setSpecType`, `setDrafter`, `trimMemory`, `onToken`, `dispose`.
- **`capacitorLlama`** — default singleton `LlamaAdapter` (back-compat; new code should use `registerCapacitorLlamaLoader` which creates per-role instances).
- **`registerCapacitorLlamaLoader(runtime)`** — registers the `localInferenceLoader` service on the elizaOS runtime; creates separate chat and embedding adapter instances to avoid native context ID collisions (fix for eliza#7681).
- **`DeviceBridgeClient`** / **`startDeviceBridgeClient`** — WebSocket client that runs inside the mobile app; relays `load`/`generate`/`embed`/`formatChat` RPC from the agent container to the device over the `device-bridge` WebSocket protocol.
- **`serializeTokenTree`** / **`deserializeTokenTree`** — binary codec for `TokenTreeDescriptor` payloads used by the native speculative-decode sampler hook (wire format: little-endian, magic `0x544B5452`, version 1).

## Layout

```
src/
  index.ts                  Public exports — CapacitorLlamaAdapter, capacitorLlama,
                              registerCapacitorLlamaLoader, DeviceBridgeClient,
                              startDeviceBridgeClient, serializeTokenTree,
                              deserializeTokenTree, plus all types from definitions.ts
  definitions.ts            All shared types: LlamaAdapter, LoadOptions, GenerateOptions,
                              GenerateResult, GenerateStreamOptions, GenerationEvent,
                              HardwareInfo, EmbedOptions, EmbedResult, SamplerStage,
                              SetSpecTypeArgs, TokenTreeDescriptor, TokenSequence, PrefillPlan
  capacitor-llama-adapter.ts  CapacitorLlamaAdapter class + capacitorLlama singleton +
                              registerCapacitorLlamaLoader function; core native bridge wiring
  device-bridge-client.ts   DeviceBridgeClient WebSocket relay (mobile→agent RPC)
  load-capacitor-llama.ts   Module-level singleton cache for the default adapter
  kv-cache-resolver.ts      Pure resolver for KV cache type precedence chain
                              (explicit > ELIZA_LLAMA_CACHE_TYPE_K/V env > fp16 default)
  token-tree-codec.ts       serializeTokenTree / deserializeTokenTree binary codec

  capacitor-llama-adapter.test.ts
  generate-stream.test.ts
  kv-cache-resolver.test.ts
  token-tree-codec.test.ts
android/                    Android-specific native stubs (Capacitor plugin glue)
rollup.config.mjs           Rollup bundle config (CJS + ESM outputs)
```

## Commands

```bash
bun run --cwd plugins/plugin-native-llama build    # clean + tsc + rollup
bun run --cwd plugins/plugin-native-llama clean    # rm dist/
bun run --cwd plugins/plugin-native-llama watch    # tsc --watch
```

There is no standalone test script in package.json; tests are run by the repo-level `bun run test` harness via vitest.

## Config / env vars

| Var | Required | Description |
|-----|----------|-------------|
| `ELIZA_LLAMA_CACHE_TYPE_K` | no | KV-cache key type override — `f16`, `tbq3_0`, or `tbq4_0`. Stock builds ignore non-`f16` values (warn-no-op). |
| `ELIZA_LLAMA_CACHE_TYPE_V` | no | KV-cache value type override — same values as above. |

Both env vars are read by `kv-cache-resolver.ts`. Callers can also pass explicit `cacheTypeK`/`cacheTypeV` fields on `LoadOptions` which take precedence.

No other env vars are consumed. `DeviceBridgeClientConfig` (`agentUrl`, `pairingToken`, `deviceId`) is supplied by the host app's pairing flow at runtime.

## How to extend

**Add a method to `LlamaAdapter`:**
1. Declare the method signature in `src/definitions.ts` on the `LlamaAdapter` interface (optional marker `?` for native-only capabilities that stock builds warn-and-no-op).
2. Implement it in `CapacitorLlamaAdapter` in `src/capacitor-llama-adapter.ts`.
3. If the method should be reachable from the agent container over the bridge, add the request type to `AgentInbound` and response type to `DeviceOutbound` in `src/device-bridge-client.ts`, then handle the new `msg.type` in `handleAgentMessage`.
4. Export from `src/index.ts` if it is a free function.

**Add a new sampler-stage kind:**
Add a new variant to the `SamplerStage` union in `src/definitions.ts`. The native bridge feature-detects `kind` and warns on unknowns so old bridge builds continue to function.

## Conventions / gotchas

- **One native context per adapter instance.** `CapacitorLlamaAdapter` allocates a unique `contextId` from a module-level counter. Never share one instance for both chat and embedding — `registerCapacitorLlamaLoader` creates two separate instances exactly for this reason.
- **iOS GPU default: Metal on.** Android default: GPU off (Capacitor wrapper is CPU-only unless a Vulkan-capable fork is used). Controlled via `LoadOptions.useGpu`.
- **`llama-cpp-capacitor` is dynamically imported** inside `loadPlugin()` so the adapter can be bundled into desktop builds without import-resolution errors. The native plugin is feature-detected at call time; missing methods are warn-and-no-op.
- **`buun-llama-cpp` fork** exposes `setCacheType`, `setSpecType`, and `getNativeKernels` methods not present in stock builds. The adapter feature-detects all three; stock builds silently skip them.
- **`generateStream`** is the canonical generation path. `generate()` is a wrapper that drains the stream into a single `GenerateResult`.
- **Mobile token cap:** `resolveMobileMaxTokens` clamps `maxTokens` to 256 on mobile to avoid OOM. Adjust `MOBILE_MAX_TOKENS_CAP` in `capacitor-llama-adapter.ts` if the cap needs to change.
- **Token tree codec:** `serializeTokenTree` / `deserializeTokenTree` must stay in sync with the native C++ sampler. The wire format is versioned (version 1); bump `VERSION` in `token-tree-codec.ts` and update the native side together.
- **No elizaOS plugin manifest:** This package does not export an elizaOS `Plugin` object and is not loaded via the normal plugin auto-enable path. It is wired manually via `registerCapacitorLlamaLoader` in the Capacitor bootstrap.
- **`@elizaos/ui` dep avoided by design.** `TokenTreeDescriptor` / `TokenSequence` are re-declared locally in `definitions.ts` so this package does not depend on `@elizaos/ui`.
- See the root [AGENTS.md](../../AGENTS.md) for repo-wide architecture rules, logger conventions, and ESM/naming standards.

/**
 * Coordinates which model is currently loaded into the plugin-local-ai
 * runtime. Eliza runs one inference model at a time; switching models
 * unloads the previous one first so we don't double-allocate VRAM.
 *
 * This module *does not* talk to `node-llama-cpp` directly. The plugin
 * owns the native binding; we ask it to swap via a small runtime service
 * registered under the name "localInferenceLoader". When the plugin is not
 * enabled, we still track the user's preferred active model so the
 * preference survives enabling the plugin later.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ELIZA_1_PLACEHOLDER_IDS, FIRST_RUN_DEFAULT_MODEL_ID } from "./catalog";
import { recommendForFirstRun } from "./recommendation";
import type { ActiveModelState, InstalledModel } from "./types";

export {
  ELIZA_1_PLACEHOLDER_IDS,
  FIRST_RUN_DEFAULT_MODEL_ID,
  recommendForFirstRun,
};
/**
 * KV cache placement strategy. `node-llama-cpp` does not currently expose a
 * direct KV-cache placement knob distinct from the model-level `gpuLayers`
 * setting (the KV cache lives wherever the layer that owns it lives). We
 * keep the type here so the API/UI surface and the upstream out-of-process
 * `llama-server` backend can plumb a real choice through; the in-process
 * binding maps any non-default value to a `gpuLayers` override or warns
 * loudly when the value cannot be honoured.
 */
export type KvOffloadMode =
  | "cpu"
  | "gpu"
  | "split"
  | {
      gpuLayers: number;
    };
/**
 * Per-load overrides accepted by `localInferenceLoader.loadModel(...)` and
 * `POST /api/local-inference/active`. Catalog defaults are merged in
 * `resolveLocalInferenceLoadArgs`; per-call overrides supplied by the
 * caller win over both catalog metadata and env-var fallbacks.
 *
 * Backend support matrix (verified against
 * eliza/packages/app-core/node_modules/node-llama-cpp/dist/evaluator/...
 * type definitions, May 2026):
 *
 *   - `contextSize`        → node-llama-cpp `LlamaContextOptions.contextSize`
 *   - `cacheTypeK/V`       → node-llama-cpp `experimentalKvCacheKeyType` /
 *                            `experimentalKvCacheValueType`. The eliza
 *                            fork binding (elizaOS/node-llama-cpp@
 *                            v3.18.1-eliza.3+) extends `GgmlType` to
 *                            accept the lowercase aliases `tbq3_0`,
 *                            `tbq4_0`, `qjl1_256`, `q4_polar` (mapped to
 *                            enum slots 43/44/46/47). Whether the C++
 *                            kernel for those types actually runs depends
 *                            on the loaded `@node-llama-cpp/<platform>`
 *                            binary: the elizaOS/llama.cpp prebuild
 *                            implements them; the upstream prebuild
 *                            forwards an unknown enum int to ggml and
 *                            errors at the kernel layer.
 *   - `gpuLayers`          → node-llama-cpp `LlamaModelOptions.gpuLayers`
 *   - `flashAttention`     → node-llama-cpp `LlamaContextOptions.flashAttention`
 *                            (also as `defaultContextFlashAttention` at
 *                            model load).
 *   - `mmap`/`mlock`       → node-llama-cpp `useMmap` / `useMlock`
 *   - `kvOffload`          → not directly exposed by node-llama-cpp; the
 *                            in-process backend translates `cpu` →
 *                            `gpuLayers: 0`, `gpu` → `gpuLayers: "max"`,
 *                            `split` → `gpuLayers: "auto"`, and
 *                            `{gpuLayers}` → that exact integer.
 */
export interface LocalInferenceLoadArgs {
  modelPath: string;
  contextSize?: number;
  useGpu?: boolean;
  maxThreads?: number;
  draftModelPath?: string;
  draftContextSize?: number;
  draftMin?: number;
  draftMax?: number;
  speculativeSamples?: number;
  mobileSpeculative?: boolean;
  cacheTypeK?: string;
  cacheTypeV?: string;
  disableThinking?: boolean;
  /**
   * Number of model layers to offload to the GPU. `"auto"` and `"max"` are
   * resolved by the backend's own probing — keep the explicit number type
   * here so the API surface accepts the most common `gpuLayers: 32` shape
   * without an extra string branch.
   */
  gpuLayers?: number;
  /**
   * Where to place the KV cache. See `KvOffloadMode`. node-llama-cpp does
   * not expose this distinct from `gpuLayers`; the backend translates
   * the request to a `gpuLayers` override or throws when the value
   * cannot be honoured.
   */
  kvOffload?: KvOffloadMode;
  flashAttention?: boolean;
  mmap?: boolean;
  mlock?: boolean;
}
export declare function isForkOnlyKvCacheType(
  name: string | undefined,
): boolean;
export declare function isStockKvCacheType(name: string | undefined): boolean;
/**
 * Validate per-load overrides against what the in-process backend can
 * honour. The AOSP loader has its own (broader) acceptance set — pass
 * `{ allowFork: true }` to skip the desktop-only restriction.
 *
 * Throws on the first illegal value so the caller (the API route) can
 * surface a 400 with a useful message instead of letting the load slip
 * through and silently degrade to fp16.
 */
export declare function validateLocalInferenceLoadArgs(
  args: Partial<LocalInferenceLoadArgs>,
  options?: {
    allowFork?: boolean;
  },
): void;
export interface LocalInferenceLoader {
  loadModel(args: LocalInferenceLoadArgs): Promise<void>;
  unloadModel(): Promise<void>;
  currentModelPath(): string | null;
  /**
   * Optional generation surface. When a loader implements this, the runtime
   * handler (`ensure-local-inference-handler.ts`) routes TEXT_SMALL /
   * TEXT_LARGE requests through it instead of the standalone engine. Mobile
   * builds populate this via the Capacitor adapter; desktop leaves it
   * unimplemented and falls back to the `LocalInferenceEngine`.
   */
  generate?(args: {
    prompt: string;
    stopSequences?: string[];
    maxTokens?: number;
    temperature?: number;
    /**
     * Optional `promptCacheKey` from the runtime cache plan. Loaders
     * that implement prefix caching (out-of-process llama-server,
     * in-process node-llama-cpp session pool) use this to pin
     * subsequent calls with the same key to the same KV cache slot.
     * Loaders without prefix caching can ignore the field.
     */
    cacheKey?: string;
  }): Promise<string>;
  /**
   * Optional embedding surface. When a loader implements this, the runtime
   * handler routes `TEXT_EMBEDDING` requests through it. The AOSP bun:ffi
   * loader populates this directly via `llama_get_embeddings_seq`; the
   * device-bridge loader populates it by dispatching an `embed` frame to
   * the connected device. Loaders that cannot embed leave this undefined,
   * and the runtime falls back to its non-local embedding provider chain.
   */
  embed?(args: { input: string }): Promise<{
    embedding: number[];
    tokens: number;
  }>;
}
/**
 * Per-load override fields the caller can set. Subset of `LocalInferenceLoadArgs`
 * minus `modelPath` (which the coordinator owns) and minus dflash-only
 * fields (which the catalog `runtime.dflash` block owns end-to-end). The
 * route layer accepts this shape on `POST /api/local-inference/active`.
 */
export interface LocalInferenceLoadOverrides {
  contextSize?: number;
  cacheTypeK?: string;
  cacheTypeV?: string;
  gpuLayers?: number;
  kvOffload?: KvOffloadMode;
  flashAttention?: boolean;
  mmap?: boolean;
  mlock?: boolean;
  useGpu?: boolean;
  maxThreads?: number;
}
export declare function resolveLocalInferenceLoadArgs(
  installed: InstalledModel,
  overrides?: LocalInferenceLoadOverrides,
): Promise<LocalInferenceLoadArgs>;
export declare class ActiveModelCoordinator {
  private state;
  private readonly listeners;
  snapshot(): ActiveModelState;
  subscribe(listener: (state: ActiveModelState) => void): () => void;
  private emit;
  /** Return the loader service from the current runtime, if registered. */
  private getLoader;
  switchTo(
    runtime: AgentRuntime | null,
    installed: InstalledModel,
    overrides?: LocalInferenceLoadOverrides,
  ): Promise<ActiveModelState>;
  unload(runtime: AgentRuntime | null): Promise<ActiveModelState>;
}
//# sourceMappingURL=active-model.d.ts.map

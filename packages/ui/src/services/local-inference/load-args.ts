/**
 * Per-load override types for the local inference engine.
 *
 * Extracted from active-model.ts to break the active-model ↔ engine
 * circular dependency. Both modules import from here; neither imports
 * from the other for these definitions.
 *
 * @module services/local-inference/load-args
 */

/**
 * KV cache placement strategy. `node-llama-cpp` does not currently expose a
 * direct KV-cache placement knob distinct from the model-level `gpuLayers`
 * setting (the KV cache lives wherever the layer that owns it lives). We
 * keep the type here so the API/UI surface and the upstream out-of-process
 * `llama-server` backend can plumb a real choice through; the in-process
 * binding maps any non-default value to a `gpuLayers` override or warns
 * loudly when the value cannot be honoured.
 */
export type KvOffloadMode = "cpu" | "gpu" | "split" | { gpuLayers: number };

/**
 * Per-load overrides accepted by `localInferenceLoader.loadModel(...)` and
 * `POST /api/local-inference/active`. Catalog defaults are merged in
 * `resolveLocalInferenceLoadArgs`; per-call overrides supplied by the
 * caller win over both catalog metadata and env-var fallbacks.
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

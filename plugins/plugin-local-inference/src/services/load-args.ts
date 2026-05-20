/**
 * Per-load override types for the local inference engine.
 *
 * Extracted from active-model.ts to break the active-model ↔ engine
 * circular dependency. Both modules import from here; neither imports
 * from the other for these definitions.
 *
 * @module services/load-args
 */

/**
 * KV cache placement strategy. `capacitor-llama` does not currently expose a
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
	/**
	 * Catalog id for direct bundle loads where `modelPath` points at a GGUF
	 * inside an Eliza-1 bundle that is not present in the installed-model
	 * registry yet.
	 */
	modelId?: string;
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
	/**
	 * Path to the multi-modal projector GGUF (mmproj-<tier>.gguf), when the
	 * loaded tier supports vision (`catalog.sourceModel.components.vision`
	 * is present AND the file exists on disk). WS2 (vision-describe)
	 * resolves this from the installed bundle root in
	 * `resolveLocalInferenceLoadArgs`. Backends that support vision use the
	 * path verbatim:
	 *   - llama-server: `--mmproj <path>` flag on spawn.
	 *   - node-llama-cpp: `mtmd_init_from_file(<path>)` (planned in fork).
	 *   - AOSP libllama shim: `eliza_llama_mtmd_init_from_file(<path>)`.
	 * Undefined when the tier doesn't ship vision or the file isn't on
	 * disk yet (e.g. downloaded text-only bundle). The text load is NOT
	 * gated on mmproj presence — text+drafter still load and vision is
	 * marked unavailable for that session.
	 */
	mmprojPath?: string;
}

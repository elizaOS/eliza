/**
 * Eliza-flavoured Capacitor llama.cpp adapter contract.
 *
 * This mirrors the `LocalInferenceLoader` interface in @elizaos/app-core so
 * `ActiveModelCoordinator` can swap between the desktop engine
 * (node-llama-cpp) and the mobile Capacitor plugin without caring which is
 * active. Native llama.cpp work is handled by `llama-cpp-capacitor`; this
 * package is intentionally just a thin mapping layer.
 */

export interface LoadOptions {
  /**
   * Absolute or sandbox path to a GGUF file on device storage. On iOS this
   * lives under `Application Support/`. On Android under the app's internal
   * files dir.
   */
  modelPath: string;
  /** Context window size; default 4096, capped by model metadata. */
  contextSize?: number;
  /** Hint: when true, the native layer uses GPU/Metal/Vulkan where available. */
  useGpu?: boolean;
  /** Cap on native thread count; native layer picks a reasonable default otherwise. */
  maxThreads?: number;
  /** Optional draft GGUF for native speculative decoding builds. */
  draftModelPath?: string;
  /** Context window for the draft model when supported by the native build. */
  draftContextSize?: number;
  /** Lower/upper speculative draft bounds for fork builds that expose them. */
  draftMin?: number;
  draftMax?: number;
  /** Number of draft tokens/samples when the native runtime supports it. */
  speculativeSamples?: number;
  /** Mobile runtimes may enable a lower-memory speculative path. */
  mobileSpeculative?: boolean;
  /** Optional KV cache types for fork builds such as TurboQuant. */
  cacheTypeK?: string;
  cacheTypeV?: string;
  /** Eliza-1 DFlash drafters are trained for non-thinking outputs. */
  disableThinking?: boolean;
}

export interface GenerateOptions {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /** When true, token events fire on the "token" listener. */
  stream?: boolean;
  /**
   * Forwarded promptCacheKey from `ProviderCachePlan`. Native plugins
   * that support prefix caching should derive a slot id from this and
   * keep KV warm for repeated calls with the same key. Plugins without
   * cache support ignore the field; behavior is unchanged.
   */
  cacheKey?: string;
}

export interface GenerateResult {
  text: string;
  promptTokens: number;
  outputTokens: number;
  durationMs: number;
}

/**
 * Local re-declaration of the token-tree wire format used by sampler stages.
 * Structurally identical to `TokenTreeDescriptor` in
 * `packages/ui/src/services/local-inference/token-tree.ts` so payloads built
 * by the harness flow through this package without any conversion. Kept
 * local so `@elizaos/capacitor-llama` doesn't take a dep on `@elizaos/ui`.
 */
export interface TokenSequence {
  name: string;
  tokens: number[];
}

export interface TokenTreeDescriptor {
  path: string;
  leaves: TokenSequence[];
}

/**
 * Prefill plan for the speculative-decode "warm prefix" sampler stage.
 * `prefix` is the deterministic head; `runs` describe deterministic
 * continuations gated by an upstream free-form span of `afterFreeSpan`
 * tokens.
 */
export interface PrefillPlan {
  prefix: string;
  runs: Array<{ afterFreeSpan: number; text: string }>;
}

/**
 * Per-generation sampler-stage injection. Each variant carries the payload
 * one fork-side sampler hook understands. New variants must be additive — old
 * native bridges feature-detect `kind` and warn-and-no-op on unknowns.
 */
export type SamplerStage =
  | { kind: "token_tree"; descriptor: TokenTreeDescriptor }
  | { kind: "prefill_plan"; plan: PrefillPlan }
  | { kind: "logit_bias"; bias: Record<number, number> }
  | { kind: "json_schema"; schema: unknown };

/**
 * Speculative-decode acceptance telemetry surfaced once per `done` event
 * (or interleaved during generation when the fork supports streaming
 * telemetry). `acceptanceRate` is `accepted / drafted` when `drafted > 0`.
 */
export interface SpecDecodeTelemetry {
  drafted: number;
  accepted: number;
  acceptanceRate: number;
}

/**
 * Streaming event emitted by `generateStream`. The stream always ends with
 * exactly one `done` event (or one `error` event with `recoverable: false`).
 * Order of non-terminal events is delivery-order from the native bridge.
 */
export type GenerationEvent =
  | { kind: "token"; text: string; tokenId?: number; index: number }
  | { kind: "tool_call"; name: string; arguments: object; raw: string }
  | { kind: "decision"; key: string; value: unknown }
  | { kind: "telemetry"; tokensPerSec: number; spec?: SpecDecodeTelemetry }
  | { kind: "error"; message: string; recoverable: boolean }
  | { kind: "done"; finishReason: "stop" | "length" | "tool" | "cancel" | "error" };

export interface GenerateStreamOptions extends GenerateOptions {
  /**
   * Toggle speculative decoding for this single generation. "auto" leaves
   * the decision to the loaded model's configuration (the default). `true`
   * forces spec-decode on builds that support it; `false` disables it even
   * when a drafter is loaded.
   */
  specDecode?: boolean | "auto";
  /**
   * Sampler-stage pipeline applied to this generation only. The native
   * bridge feature-detects each kind; unrecognised stages are warned and
   * skipped rather than failing the call.
   */
  samplerStages?: SamplerStage[];
}

export interface HardwareInfo {
  platform: "ios" | "android" | "web";
  /** Human-readable device model when the OS exposes one. */
  deviceModel: string;
  /** Stable OS machine identifier when available, e.g. iPhone16,2. */
  machineId?: string;
  osVersion?: string;
  isSimulator?: boolean;
  totalRamGb: number;
  availableRamGb: number | null;
  freeStorageGb?: number | null;
  cpuCores: number;
  gpu: {
    backend: "metal" | "vulkan" | "gpu-delegate";
    available: boolean;
  } | null;
  /** True when the underlying llama.cpp build has GPU support compiled in. */
  gpuSupported: boolean;
  lowPowerMode?: boolean;
  thermalState?: "nominal" | "fair" | "serious" | "critical" | "unknown";
  /** True only when the native build can load a drafter and run DFlash/spec decode. */
  dflashSupported?: boolean;
  dflashReason?: string;
  source?: "native" | "adapter-fallback";
  /**
   * Names of fork-specific kernels compiled into the loaded native library
   * (e.g. "turbo3", "turbo4", "turbo3_tcq", "dflash", "qjl_full"). Empty
   * when the loaded build is stock llama.cpp or when no native lib is loaded.
   * Surfaced from the native bridge via a `kernels.json` manifest shipped
   * alongside the .so.
   */
  nativeKernels?: string[];
  /**
   * Which native llama.cpp variant is loaded. `null` when the plugin
   * isn't loaded at all (web fallback or native lib failed to load).
   */
  forkVariant?: "buun-llama-cpp" | "stock-llama-cpp" | null;
}

export interface EmbedOptions {
  /** Raw text to embed. The adapter forwards this verbatim to the native plugin. */
  input: string;
  /**
   * Optional L2 normalisation passed through to llama-cpp-capacitor's
   * `embd_normalize` parameter. Native default is 0 (off); set to 2 for
   * L2-normalised vectors that match most cloud embedding APIs.
   */
  embdNormalize?: number;
}

export interface EmbedResult {
  embedding: number[];
  /**
   * Token count of the embedded input. The native plugin doesn't return
   * this directly so adapters may estimate via `tokenize` and report 0
   * when an estimate is unavailable. Always present so downstream
   * accounting code doesn't have to special-case undefined.
   */
  tokens: number;
}

export interface SetSpecTypeArgs {
  /** Path to the target (large) GGUF. */
  target: string;
  /** Path to the drafter (small) GGUF. */
  drafter: string;
  /** Currently only "dflash" is honoured by the buun fork. */
  specType: "dflash";
  draftMin: number;
  draftMax: number;
}

export interface LlamaAdapter {
  getHardwareInfo(): Promise<HardwareInfo>;
  isLoaded(): Promise<{ loaded: boolean; modelPath: string | null }>;
  currentModelPath(): string | null;
  load(options: LoadOptions): Promise<void>;
  unload(): Promise<void>;
  generate(options: GenerateOptions): Promise<GenerateResult>;
  /**
   * Streaming generation surface. Emits typed events (token, tool_call,
   * decision, telemetry, error, done) instead of bare strings. The legacy
   * `generate(...)` is now a wrapper that drains the stream into a single
   * `GenerateResult` for callers that don't care about per-event detail.
   *
   * The stream is single-use and must terminate with exactly one `done`
   * event (or one terminal `error` with `recoverable: false`). Callers
   * that abandon the iterator before `done` should call `cancelGenerate()`
   * to release the native bridge.
   */
  generateStream(
    options: GenerateStreamOptions,
  ): AsyncIterable<GenerationEvent>;
  cancelGenerate(): Promise<void>;
  /** Fires when `generate({ stream: true })` emits a new token. */
  onToken(listener: (token: string, index: number) => void): () => void;
  /**
   * Swap the speculative-decode drafter without tearing down the main
   * context. Passing `null` clears the active drafter. Stock builds that
   * have no drafter bridge warn-and-no-op.
   */
  setDrafter?(drafterPath: string | null): Promise<void>;
  /**
   * Memory-pressure hook surfaced by the host OS. `minor` is the OS hint
   * ("trim if convenient"); `major` is the imminent-kill warning. Adapters
   * should drop caches / shrink KV reservations and may unload the drafter.
   */
  trimMemory?(level: "minor" | "major"): Promise<void>;
  /**
   * Compute a single sentence embedding. Returns the raw float vector and
   * (when known) the input token count. Throws when the underlying plugin
   * does not expose an embedding method on the active platform.
   */
  embed(options: EmbedOptions): Promise<EmbedResult>;
  /**
   * Configure the KV cache types used by the next loaded context. Only
   * the buun-llama-cpp fork honours TurboQuant cache types like
   * `q4_tq3` / `q4_tq4`. Stock builds will warn-and-no-op when the
   * underlying plugin doesn't expose the bridge method.
   */
  setCacheType?(typeK: string, typeV: string): Promise<void>;
  /**
   * Configure DFlash speculative decoding for the next loaded context.
   * Stock builds without speculative bridge methods warn-and-no-op.
   */
  setSpecType?(args: SetSpecTypeArgs): Promise<void>;
  /**
   * Apply the loaded model's native chat template to a list of
   * `{role, content}` messages and return the rendered prompt string.
   * Backed by llama.cpp's `llama_chat_apply_template` which uses the
   * GGUF's own Jinja template — handles Llama-3, Qwen, Mistral, Phi,
   * etc. without per-model code on the caller side. Returns null when
   * the loaded GGUF has no chat template baked in.
   */
  formatChat?(
    messages: { role: string; content: string }[],
  ): Promise<string | null>;
}

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
  /** Number of draft tokens/samples when the native runtime supports it. */
  speculativeSamples?: number;
  /** Mobile runtimes may enable a lower-memory speculative path. */
  mobileSpeculative?: boolean;
  /** Optional KV cache types for fork builds such as TurboQuant. */
  cacheTypeK?: string;
  cacheTypeV?: string;
}

export interface GenerateOptions {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /** When true, token events fire on the "token" listener. */
  stream?: boolean;
}

export interface GenerateResult {
  text: string;
  promptTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface HardwareInfo {
  platform: "ios" | "android" | "web";
  /** Human-readable device model when the OS exposes one. */
  deviceModel: string;
  totalRamGb: number;
  availableRamGb: number | null;
  cpuCores: number;
  gpu: {
    backend: "metal" | "vulkan" | "gpu-delegate";
    available: boolean;
  } | null;
  /** True when the underlying llama.cpp build has GPU support compiled in. */
  gpuSupported: boolean;
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

export interface LlamaAdapter {
  getHardwareInfo(): Promise<HardwareInfo>;
  isLoaded(): Promise<{ loaded: boolean; modelPath: string | null }>;
  currentModelPath(): string | null;
  load(options: LoadOptions): Promise<void>;
  unload(): Promise<void>;
  generate(options: GenerateOptions): Promise<GenerateResult>;
  cancelGenerate(): Promise<void>;
  /** Fires when `generate({ stream: true })` emits a new token. */
  onToken(listener: (token: string, index: number) => void): () => void;
  /**
   * Compute a single sentence embedding. Returns the raw float vector and
   * (when known) the input token count. Throws when the underlying plugin
   * does not expose an embedding method on the active platform.
   */
  embed(options: EmbedOptions): Promise<EmbedResult>;
}

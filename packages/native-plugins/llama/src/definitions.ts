/**
 * Milady-flavoured Capacitor llama.cpp adapter contract.
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
  gpu: { backend: "metal" | "vulkan" | "gpu-delegate"; available: boolean } | null;
  /** True when the underlying llama.cpp build has GPU support compiled in. */
  gpuSupported: boolean;
}

export interface LlamaAdapter {
  getHardwareInfo(): Promise<HardwareInfo>;
  isLoaded(): Promise<{ loaded: boolean; modelPath: string | null }>;
  load(options: LoadOptions): Promise<void>;
  unload(): Promise<void>;
  generate(options: GenerateOptions): Promise<GenerateResult>;
  cancelGenerate(): Promise<void>;
  /** Fires when `generate({ stream: true })` emits a new token. */
  onToken(listener: (token: string, index: number) => void): () => void;
}

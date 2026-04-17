import type { PluginListenerHandle } from "@capacitor/core";

/**
 * Capacitor plugin contract for on-device llama.cpp inference.
 *
 * The shape intentionally mirrors `LocalInferenceLoader` +
 * `LocalInferenceEngine` in @elizaos/app-core so the existing
 * ActiveModelCoordinator can swap between the desktop (node-llama-cpp)
 * engine and this mobile plugin via the same service contract.
 */

export interface LlamaLoadOptions {
  /**
   * Absolute or scoped-URI path to a GGUF file on device storage. On iOS
   * this may live under `Application Support/llama-models/`. On Android
   * under the app's internal files dir or a scoped storage URI.
   */
  modelPath: string;
  /** Optional context window override; defaults to model metadata. */
  contextSize?: number;
  /** Optional cap on number of threads the native runtime may use. */
  maxThreads?: number;
  /**
   * When true the plugin attempts to use a GPU delegate (Metal on iOS,
   * GPU/Vulkan on Android). Defaults to platform-native best effort.
   */
  useGpu?: boolean;
}

export interface LlamaGenerateOptions {
  /** Prompt text to feed the model. */
  prompt: string;
  /** Upper bound on output tokens; plugin clamps to model context minus prompt length. */
  maxTokens?: number;
  /** 0..1 temperature; defaults to 0.7. */
  temperature?: number;
  /** Nucleus sampling; defaults to 0.9. */
  topP?: number;
  /** Stop generation on any of these substrings. */
  stopSequences?: string[];
  /**
   * Stream tokens as they arrive via the "token" plugin listener. When
   * false (the default) `generate` resolves once with the full text.
   */
  stream?: boolean;
}

export interface LlamaGenerateResult {
  /** Generated text (full output when non-streaming; "" when streaming). */
  text: string;
  /** Number of prompt tokens consumed. */
  promptTokens: number;
  /** Number of output tokens generated. */
  outputTokens: number;
  /** Wall-clock milliseconds spent in native inference. */
  durationMs: number;
}

export interface LlamaTokenEvent {
  /** A single decoded token chunk. */
  token: string;
  /** Cumulative output-token count at the time this token fired. */
  index: number;
}

export interface LlamaHardwareInfo {
  platform: "ios" | "android";
  deviceModel: string;
  totalRamGb: number;
  /** Only populated when the OS exposes a detail-level RAM reading. */
  availableRamGb: number | null;
  gpu:
    | { backend: "metal" | "vulkan" | "gpu-delegate"; available: boolean }
    | null;
  cpuCores: number;
  /** Whether the plugin was compiled with GPU support on this device. */
  gpuSupported: boolean;
}

export interface LlamaCapacitorPlugin {
  /** Report hardware capabilities so the UI can filter model options. */
  getHardwareInfo(): Promise<LlamaHardwareInfo>;
  /** Returns true if a model is currently loaded. */
  isLoaded(): Promise<{ loaded: boolean; modelPath: string | null }>;
  /** Load a GGUF file into native memory. Unloads any prior model first. */
  loadModel(options: LlamaLoadOptions): Promise<void>;
  /** Unload the current model and release native memory. */
  unloadModel(): Promise<void>;
  /**
   * Generate text. When `stream: true`, tokens are also emitted via the
   * "token" listener and the resolved text is empty.
   */
  generate(options: LlamaGenerateOptions): Promise<LlamaGenerateResult>;
  /** Cancel any in-flight generation. No-op if idle. */
  cancelGenerate(): Promise<void>;

  /** Token-by-token streaming hook (fires only when `stream: true`). */
  addListener(
    eventName: "token",
    listener: (event: LlamaTokenEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** Fires once at the end of a streamed generation. */
  addListener(
    eventName: "generationComplete",
    listener: (event: LlamaGenerateResult) => void,
  ): Promise<PluginListenerHandle>;

  /** Fires when generation fails mid-stream. */
  addListener(
    eventName: "generationError",
    listener: (event: { message: string }) => void,
  ): Promise<PluginListenerHandle>;
}

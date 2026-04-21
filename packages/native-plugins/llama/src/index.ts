/**
 * @elizaos/capacitor-llama
 *
 * Thin adapter that maps `llama-cpp-capacitor`'s contextId-based API onto
 * Milady's `LocalInferenceLoader` contract. At most one native context lives
 * at a time; switching models disposes the previous context first so we
 * never double-allocate VRAM.
 *
 * On web this package falls back to an "unavailable" stub. Mobile builds
 * should call `registerCapacitorLlamaLoader(runtime)` during bootstrap to
 * wire this adapter in as the runtime's `localInferenceLoader` service.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import type {
  NativeCompletionParams,
  NativeCompletionResult,
  NativeCompletionTokenProb,
  NativeContextParams,
  NativeLlamaContext,
} from "llama-cpp-capacitor";
import type {
  GenerateOptions,
  GenerateResult,
  HardwareInfo,
  LlamaAdapter,
  LoadOptions,
} from "./definitions";

export * from "./definitions";
export {
  DeviceBridgeClient,
  type DeviceBridgeClientConfig,
  startDeviceBridgeClient,
} from "./device-bridge-client";

// Dynamically imported so the adapter can be bundled into a desktop build
// without pulling in native-only module resolution noise.
type NativeGenerateParams = Partial<Omit<NativeCompletionParams, "prompt">>;

type TokenEventPayload = {
  token?: string;
  completion_probabilities?: NativeCompletionTokenProb[];
  tokenResult?: {
    token?: string;
    completion_probabilities?: NativeCompletionTokenProb[];
  };
};

interface LlamaCppCapacitorModule {
  default?: LlamaCppPluginLike;
  LlamaCpp?: LlamaCppPluginLike;
}

interface LlamaCppPluginLike {
  initContext: (options: {
    contextId: number;
    params: NativeContextParams;
  }) => Promise<NativeLlamaContext>;
  releaseContext: (options: { contextId: number }) => Promise<void>;
  releaseAllContexts: () => Promise<void>;
  generateText: (options: {
    contextId: number;
    prompt: string;
    params?: NativeGenerateParams;
  }) => Promise<NativeCompletionResult>;
  stopCompletion: (options: { contextId: number }) => Promise<void>;
  addListener: (
    event: string,
    listener: (data: TokenEventPayload) => void,
  ) => Promise<PluginListenerHandle | void>;
}

const CONTEXT_ID = 1;

function isCapacitorNative(): boolean {
  const cap = (globalThis as Record<string, unknown>).Capacitor as
    | { isNativePlatform?: () => boolean; getPlatform?: () => string }
    | undefined;
  return Boolean(cap?.isNativePlatform?.());
}

function detectPlatform(): "ios" | "android" | "web" {
  const cap = (globalThis as Record<string, unknown>).Capacitor as
    | { getPlatform?: () => string }
    | undefined;
  const platform = cap?.getPlatform?.();
  if (platform === "ios") return "ios";
  if (platform === "android") return "android";
  return "web";
}

class CapacitorLlamaAdapter implements LlamaAdapter {
  private plugin: LlamaCppPluginLike | null = null;
  /** Cached loader promise so concurrent `load()` calls don't race to register duplicate listeners. */
  private pluginLoadPromise: Promise<LlamaCppPluginLike> | null = null;
  private loadedPath: string | null = null;
  private tokenIndex = 0;
  private tokenListeners = new Set<(token: string, index: number) => void>();
  private pluginListenerHandle: PluginListenerHandle | null = null;

  private async loadPlugin(): Promise<LlamaCppPluginLike> {
    if (this.plugin) return this.plugin;
    if (this.pluginLoadPromise) return this.pluginLoadPromise;
    this.pluginLoadPromise = (async () => {
      const mod = (await import(
        "llama-cpp-capacitor"
      )) as LlamaCppCapacitorModule;
      const plugin = mod.default ?? mod.LlamaCpp;
      if (!plugin || typeof plugin.initContext !== "function") {
        throw new Error(
          "llama-cpp-capacitor did not expose an initContext method",
        );
      }
      // Set up the token listener once; it fans out to registered listeners.
      const tokenListenerHandle = await plugin.addListener(
        "@LlamaCpp_onToken",
        (data) => {
          const token = data.tokenResult?.token ?? data.token;
          if (!token) return;
          this.tokenIndex += 1;
          for (const listener of this.tokenListeners) {
            try {
              listener(token, this.tokenIndex);
            } catch {
              this.tokenListeners.delete(listener);
            }
          }
        },
      );
      this.pluginListenerHandle = tokenListenerHandle ?? null;
      this.plugin = plugin;
      return plugin;
    })();
    try {
      return await this.pluginLoadPromise;
    } catch (err) {
      // Failed loads must not poison the cache — let the next call retry.
      this.pluginLoadPromise = null;
      throw err;
    }
  }

  async getHardwareInfo(): Promise<HardwareInfo> {
    const platform = detectPlatform();
    // `navigator` is undefined on Node/Bun; this adapter may be imported
    // (never instantiated) from server-side code that transitively pulls
    // in @elizaos/app-core. Read through `globalThis` so the lookup is
    // safe on every platform.
    const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } })
      .navigator;
    return {
      platform,
      deviceModel: platform,
      totalRamGb: 0,
      availableRamGb: null,
      cpuCores: nav?.hardwareConcurrency ?? 0,
      gpu: null,
      gpuSupported: platform !== "web",
    };
  }

  async isLoaded(): Promise<{ loaded: boolean; modelPath: string | null }> {
    return {
      loaded: this.loadedPath !== null,
      modelPath: this.loadedPath,
    };
  }

  currentModelPath(): string | null {
    return this.loadedPath;
  }

  async load(options: LoadOptions): Promise<void> {
    if (!isCapacitorNative()) {
      throw new Error(
        "capacitor-llama is only available on iOS and Android builds",
      );
    }
    const plugin = await this.loadPlugin();

    if (this.loadedPath && this.loadedPath !== options.modelPath) {
      await plugin.releaseAllContexts();
      this.loadedPath = null;
    }

    await plugin.initContext({
      contextId: CONTEXT_ID,
      params: {
        model: options.modelPath,
        n_ctx: options.contextSize ?? 4096,
        n_gpu_layers: options.useGpu === false ? 0 : 99,
        n_threads: options.maxThreads ?? 0,
        use_mmap: true,
      },
    });
    this.loadedPath = options.modelPath;
  }

  async unload(): Promise<void> {
    if (!this.plugin || !this.loadedPath) return;
    try {
      await this.plugin.releaseContext({ contextId: CONTEXT_ID });
    } catch {
      await this.plugin.releaseAllContexts();
    }
    this.loadedPath = null;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    if (!this.plugin || !this.loadedPath) {
      throw new Error("No model loaded. Call load() first.");
    }
    this.tokenIndex = 0;

    const params: NativeGenerateParams = {
      n_predict: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0.7,
      top_p: options.topP ?? 0.9,
    };
    if (options.stopSequences && options.stopSequences.length > 0) {
      params.stop = options.stopSequences;
    }
    if (options.stream) {
      params.emit_partial_completion = true;
    }

    const started = Date.now();
    const result = await this.plugin.generateText({
      contextId: CONTEXT_ID,
      prompt: options.prompt,
      params,
    });
    const duration =
      result.timings?.predicted_ms != null
        ? Math.round(result.timings.predicted_ms)
        : Date.now() - started;

    return {
      text: result.text,
      promptTokens: result.tokens_evaluated,
      outputTokens: result.tokens_predicted,
      durationMs: duration,
    };
  }

  async cancelGenerate(): Promise<void> {
    if (!this.plugin) return;
    await this.plugin.stopCompletion({ contextId: CONTEXT_ID });
  }

  onToken(listener: (token: string, index: number) => void): () => void {
    this.tokenListeners.add(listener);
    return () => {
      this.tokenListeners.delete(listener);
    };
  }

  /** Exposed so callers can tear down the plugin listener on app shutdown. */
  async dispose(): Promise<void> {
    this.tokenListeners.clear();
    if (this.pluginListenerHandle) {
      await this.pluginListenerHandle.remove();
      this.pluginListenerHandle = null;
    }
    await this.unload();
    this.plugin = null;
    this.pluginLoadPromise = null;
  }
}

export const capacitorLlama: LlamaAdapter = new CapacitorLlamaAdapter();

/**
 * Register this adapter as the runtime's `localInferenceLoader`. Called
 * from the Capacitor bootstrap in `@elizaos/app-core/capacitor-shell` so
 * the standard ActiveModelCoordinator routes through it on mobile.
 */
export function registerCapacitorLlamaLoader(runtime: {
  registerService?: (name: string, impl: unknown) => unknown;
}): void {
  if (typeof runtime.registerService !== "function") return;
  runtime.registerService("localInferenceLoader", {
    async loadModel(args: { modelPath: string }): Promise<void> {
      await capacitorLlama.load({ modelPath: args.modelPath });
    },
    async unloadModel(): Promise<void> {
      await capacitorLlama.unload();
    },
    currentModelPath(): string | null {
      return capacitorLlama.currentModelPath();
    },
    async generate(args: {
      prompt: string;
      stopSequences?: string[];
      maxTokens?: number;
      temperature?: number;
    }): Promise<string> {
      const result = await capacitorLlama.generate({
        prompt: args.prompt,
        stopSequences: args.stopSequences,
        maxTokens: args.maxTokens,
        temperature: args.temperature,
      });
      return result.text;
    },
  });
}

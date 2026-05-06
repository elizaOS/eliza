import type { PluginListenerHandle } from "@capacitor/core";
import type {
  NativeCompletionParams,
  NativeCompletionResult,
  NativeContextParams,
  NativeEmbeddingParams,
  NativeEmbeddingResult,
  NativeLlamaContext,
} from "llama-cpp-capacitor";
import type {
  EmbedOptions,
  EmbedResult,
  GenerateOptions,
  GenerateResult,
  HardwareInfo,
  LlamaAdapter,
  LoadOptions,
} from "./definitions";

// Dynamically imported so the adapter can be bundled into a desktop build
// without pulling in native-only module resolution noise.
type NativeGenerateParams = Partial<Omit<NativeCompletionParams, "prompt">>;
type NativeCompletionProbability = NonNullable<
  NativeCompletionResult["completion_probabilities"]
>[number];

type TokenEventPayload = {
  token?: string;
  completion_probabilities?: NativeCompletionProbability[];
  tokenResult?: {
    token?: string;
    completion_probabilities?: NativeCompletionProbability[];
  };
};

interface LlamaCppPluginLike {
  initContext: (options: {
    contextId: number;
    params: NativeContextParams;
  }) => Promise<NativeLlamaContext>;
  releaseContext: (options: { contextId: number }) => Promise<void>;
  releaseAllContexts: () => Promise<void>;
  completion?: (options: {
    contextId: number;
    params: NativeCompletionParams;
  }) => Promise<NativeCompletionResult>;
  generateText?: (options: {
    contextId: number;
    prompt: string;
    params?: NativeGenerateParams;
  }) => Promise<NativeCompletionResult>;
  stopCompletion: (options: { contextId: number }) => Promise<void>;
  /**
   * Optional - older builds of llama-cpp-capacitor (<= 0.1.4) shipped
   * without `embedding`. We feature-detect at call-time so the adapter
   * still loads on those builds and just throws on `embed()` rather than
   * failing during plugin probe.
   */
  embedding?: (options: {
    contextId: number;
    text: string;
    params: NativeEmbeddingParams;
  }) => Promise<NativeEmbeddingResult>;
  /**
   * Optional - used to count input tokens for the `tokens` field of
   * EmbedResult. Same feature-detect rationale as embedding.
   */
  tokenize?: (options: {
    contextId: number;
    text: string;
    imagePaths?: Array<string>;
  }) => Promise<{ tokens: number[] }>;
  addListener: (
    event: string,
    listener: (data: TokenEventPayload) => void,
  ) => Promise<PluginListenerHandle | void>;
}

const CONTEXT_ID = 1;
const DEFAULT_MAX_TOKENS = 256;
const MOBILE_MAX_TOKENS_CAP = 256;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLlamaCppPluginLike(value: unknown): value is LlamaCppPluginLike {
  return (
    isObject(value) &&
    typeof value.initContext === "function" &&
    typeof value.releaseContext === "function" &&
    typeof value.releaseAllContexts === "function" &&
    (typeof value.completion === "function" ||
      typeof value.generateText === "function") &&
    typeof value.stopCompletion === "function" &&
    typeof value.addListener === "function"
  );
}

function resolveLlamaCppPlugin(mod: unknown): LlamaCppPluginLike | null {
  if (!isObject(mod)) return null;
  if (isLlamaCppPluginLike(mod.LlamaCpp)) return mod.LlamaCpp;
  if (isLlamaCppPluginLike(mod.default)) return mod.default;
  if (isObject(mod.default) && isLlamaCppPluginLike(mod.default.LlamaCpp)) {
    return mod.default.LlamaCpp;
  }
  return null;
}

function toPlainLlamaCppPlugin(plugin: LlamaCppPluginLike): LlamaCppPluginLike {
  return {
    initContext: (options) => plugin.initContext(options),
    releaseContext: (options) => plugin.releaseContext(options),
    releaseAllContexts: () => plugin.releaseAllContexts(),
    completion:
      typeof plugin.completion === "function"
        ? (options) =>
            plugin.completion?.(options) as Promise<NativeCompletionResult>
        : undefined,
    generateText:
      typeof plugin.generateText === "function"
        ? (options) =>
            plugin.generateText?.(options) as Promise<NativeCompletionResult>
        : undefined,
    stopCompletion: (options) => plugin.stopCompletion(options),
    embedding:
      typeof plugin.embedding === "function"
        ? (options) =>
            plugin.embedding?.(options) as Promise<NativeEmbeddingResult>
        : undefined,
    tokenize:
      typeof plugin.tokenize === "function"
        ? (options) =>
            plugin.tokenize?.(options) as Promise<{ tokens: number[] }>
        : undefined,
    addListener: (event, listener) => plugin.addListener(event, listener),
  };
}

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

function resolveMobileMaxTokens(requested?: number): number {
  if (!Number.isFinite(requested) || requested == null || requested <= 0) {
    return DEFAULT_MAX_TOKENS;
  }
  return Math.min(Math.floor(requested), MOBILE_MAX_TOKENS_CAP);
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
      const nativePlugin = resolveLlamaCppPlugin(
        await import("llama-cpp-capacitor"),
      );
      if (!nativePlugin) {
        throw new Error(
          "llama-cpp-capacitor did not expose the native LlamaCpp methods",
        );
      }
      const plugin = toPlainLlamaCppPlugin(nativePlugin);
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
      this.pluginLoadPromise = null;
      throw err;
    }
  }

  async getHardwareInfo(): Promise<HardwareInfo> {
    const platform = detectPlatform();
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
      n_predict: resolveMobileMaxTokens(options.maxTokens),
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
    const result =
      typeof this.plugin.completion === "function"
        ? await this.plugin.completion({
            contextId: CONTEXT_ID,
            params: {
              prompt: options.prompt,
              emit_partial_completion: Boolean(params.emit_partial_completion),
              ...params,
            },
          })
        : await this.plugin.generateText?.({
            contextId: CONTEXT_ID,
            prompt: options.prompt,
            params,
          });
    if (!result) {
      throw new Error(
        "llama-cpp-capacitor did not expose completion() or generateText()",
      );
    }
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

  async embed(options: EmbedOptions): Promise<EmbedResult> {
    if (!this.plugin || !this.loadedPath) {
      throw new Error("No model loaded. Call load() first.");
    }
    if (typeof this.plugin.embedding !== "function") {
      throw new Error(
        "llama-cpp-capacitor does not expose embedding() on this build; upgrade or use a cloud embedding provider",
      );
    }
    const params: NativeEmbeddingParams = {
      embd_normalize: options.embdNormalize ?? 0,
    };
    const result = await this.plugin.embedding({
      contextId: CONTEXT_ID,
      text: options.input,
      params,
    });
    let tokenCount = 0;
    if (typeof this.plugin.tokenize === "function") {
      try {
        const tokenized = await this.plugin.tokenize({
          contextId: CONTEXT_ID,
          text: options.input,
        });
        tokenCount = tokenized.tokens.length;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.debug("[capacitor-llama] tokenize fallback", {
          error: message,
        });
        tokenCount = 0;
      }
    }
    return { embedding: result.embedding, tokens: tokenCount };
  }

  onToken(listener: (token: string, index: number) => void): () => void {
    this.tokenListeners.add(listener);
    return () => {
      this.tokenListeners.delete(listener);
    };
  }

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
    async embed(args: {
      input: string;
    }): Promise<{ embedding: number[]; tokens: number }> {
      return capacitorLlama.embed({ input: args.input });
    },
  });
}

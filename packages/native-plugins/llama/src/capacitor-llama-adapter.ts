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
  getHardwareInfo?: () => Promise<Partial<HardwareInfo>>;
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
  ) => Promise<PluginListenerHandle | undefined>;
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
    getHardwareInfo:
      typeof plugin.getHardwareInfo === "function"
        ? () => plugin.getHardwareInfo?.() as Promise<Partial<HardwareInfo>>
        : undefined,
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

function numberFromUnknown(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function booleanFromUnknown(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function fallbackHardwareInfo(
  platform = detectPlatform(),
  reason = "native hardware probe unavailable",
): HardwareInfo {
  const nav = (
    globalThis as {
      navigator?: { hardwareConcurrency?: number; deviceMemory?: number };
    }
  ).navigator;
  const totalRamGb = numberFromUnknown(nav?.deviceMemory) ?? 0;
  const gpu =
    platform === "ios"
      ? ({ backend: "metal", available: true } as const)
      : platform === "android"
        ? ({ backend: "vulkan", available: true } as const)
        : null;
  return {
    platform,
    deviceModel: platform,
    totalRamGb,
    availableRamGb: null,
    cpuCores: nav?.hardwareConcurrency ?? 0,
    gpu,
    gpuSupported: platform !== "web",
    dflashSupported: false,
    dflashReason: reason,
    source: "adapter-fallback",
  };
}

function normalizeHardwareInfo(
  value: Partial<HardwareInfo> | null | undefined,
  platform = detectPlatform(),
): HardwareInfo {
  const fallback = fallbackHardwareInfo(platform);
  if (!value) return fallback;
  const totalRamGb = numberFromUnknown(value.totalRamGb) ?? fallback.totalRamGb;
  const availableRamGb =
    value.availableRamGb === null
      ? null
      : numberFromUnknown(value.availableRamGb) ?? fallback.availableRamGb;
  const gpu =
    value.gpu && isObject(value.gpu)
      ? {
          backend:
            value.gpu.backend === "metal" ||
            value.gpu.backend === "vulkan" ||
            value.gpu.backend === "gpu-delegate"
              ? value.gpu.backend
              : fallback.gpu?.backend ?? "gpu-delegate",
          available: Boolean(value.gpu.available),
        }
      : fallback.gpu;
  return {
    platform:
      value.platform === "ios" ||
      value.platform === "android" ||
      value.platform === "web"
        ? value.platform
        : platform,
    deviceModel: stringFromUnknown(value.deviceModel) ?? fallback.deviceModel,
    ...(stringFromUnknown(value.machineId)
      ? { machineId: stringFromUnknown(value.machineId) }
      : {}),
    ...(stringFromUnknown(value.osVersion)
      ? { osVersion: stringFromUnknown(value.osVersion) }
      : {}),
    ...(typeof value.isSimulator === "boolean"
      ? { isSimulator: value.isSimulator }
      : {}),
    totalRamGb,
    availableRamGb,
    ...(numberFromUnknown(value.freeStorageGb) !== null
      ? { freeStorageGb: numberFromUnknown(value.freeStorageGb) }
      : {}),
    cpuCores: numberFromUnknown(value.cpuCores) ?? fallback.cpuCores,
    gpu,
    gpuSupported:
      booleanFromUnknown(value.gpuSupported) ?? fallback.gpuSupported,
    ...(typeof value.lowPowerMode === "boolean"
      ? { lowPowerMode: value.lowPowerMode }
      : {}),
    ...(value.thermalState === "nominal" ||
    value.thermalState === "fair" ||
    value.thermalState === "serious" ||
    value.thermalState === "critical" ||
    value.thermalState === "unknown"
      ? { thermalState: value.thermalState }
      : {}),
    dflashSupported: Boolean(value.dflashSupported),
    dflashReason:
      stringFromUnknown(value.dflashReason) ??
      (value.dflashSupported
        ? undefined
        : "native plugin did not report DFlash support"),
    source: value.source === "native" ? "native" : "adapter-fallback",
  };
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
    if (!isCapacitorNative()) return fallbackHardwareInfo(platform);
    try {
      const plugin = await this.loadPlugin();
      return normalizeHardwareInfo(await plugin.getHardwareInfo?.(), platform);
    } catch (error) {
      return fallbackHardwareInfo(
        platform,
        error instanceof Error ? error.message : "native hardware probe failed",
      );
    }
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

    const speculativeSamples = options.mobileSpeculative
      ? Math.min(options.speculativeSamples ?? options.draftMax ?? 3, 4)
      : (options.speculativeSamples ?? 3);
    const params: NativeContextParams & Record<string, unknown> = {
      model: options.modelPath,
      n_ctx: options.contextSize ?? 4096,
      n_gpu_layers: options.useGpu === false ? 0 : 99,
      n_threads: options.maxThreads ?? 0,
      use_mmap: true,
      flash_attn: options.useGpu !== false,
      n_batch: options.mobileSpeculative ? 128 : 512,
      n_ubatch: options.mobileSpeculative ? 64 : 512,
      ...(options.draftModelPath
        ? {
            draft_model: options.draftModelPath,
            speculative_samples: speculativeSamples,
            mobile_speculative: options.mobileSpeculative ?? true,
          }
        : {}),
      ...(options.draftContextSize
        ? { n_ctx_draft: options.draftContextSize }
        : {}),
      ...(options.draftMin ? { draft_min: options.draftMin } : {}),
      ...(options.draftMax ? { draft_max: options.draftMax } : {}),
      ...(options.cacheTypeK ? { cache_type_k: options.cacheTypeK } : {}),
      ...(options.cacheTypeV ? { cache_type_v: options.cacheTypeV } : {}),
      ...(options.disableThinking ? { reasoning: false } : {}),
    };

    await plugin.initContext({
      contextId: CONTEXT_ID,
      params,
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
    async loadModel(args: LoadOptions): Promise<void> {
      await capacitorLlama.load(args);
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

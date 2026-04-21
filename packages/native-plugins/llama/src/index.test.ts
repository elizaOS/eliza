import { afterEach, describe, expect, it, vi } from "vitest";

type CapacitorGlobal = {
  Capacitor?: {
    getPlatform?: () => string;
    isNativePlatform?: () => boolean;
  };
};

type TokenPayload = {
  token?: string;
  tokenResult?: { token?: string };
};

function setNativeCapacitor(platform: "ios" | "android" = "ios"): void {
  (globalThis as CapacitorGlobal).Capacitor = {
    getPlatform: () => platform,
    isNativePlatform: () => true,
  };
}

function clearNativeCapacitor(): void {
  delete (globalThis as CapacitorGlobal).Capacitor;
}

function makePluginMock() {
  let tokenListener: ((payload: TokenPayload) => void) | null = null;
  const listenerHandle = { remove: vi.fn(async () => undefined) };

  return {
    initContext: vi.fn(async () => ({
      contextId: 1,
      gpu: true,
      reasonNoGPU: "",
      model: {
        desc: "test",
        size: 1,
        nEmbd: 1,
        nParams: 1,
        chatTemplates: {
          llamaChat: false,
          minja: {
            default: false,
            defaultCaps: {
              tools: false,
              toolCalls: false,
              toolResponses: false,
              systemRole: false,
              parallelToolCalls: false,
              toolCallId: false,
            },
            toolUse: false,
            toolUseCaps: {
              tools: false,
              toolCalls: false,
              toolResponses: false,
              systemRole: false,
              parallelToolCalls: false,
              toolCallId: false,
            },
          },
        },
        metadata: {},
        isChatTemplateSupported: false,
      },
    })),
    releaseContext: vi.fn(async () => undefined),
    releaseAllContexts: vi.fn(async () => undefined),
    generateText: vi.fn(async () => ({
      text: "hello",
      reasoning_content: "",
      tool_calls: [],
      content: "hello",
      chat_format: 0,
      tokens_predicted: 2,
      tokens_evaluated: 3,
      truncated: false,
      stopped_eos: true,
      stopped_word: "",
      stopped_limit: 0,
      stopping_word: "",
      context_full: false,
      interrupted: false,
      tokens_cached: 0,
      timings: {
        prompt_n: 3,
        prompt_ms: 1,
        prompt_per_token_ms: 1,
        prompt_per_second: 1,
        predicted_n: 2,
        predicted_ms: 7,
        predicted_per_token_ms: 1,
        predicted_per_second: 1,
      },
    })),
    stopCompletion: vi.fn(async () => undefined),
    addListener: vi.fn(
      async (_event: string, listener: (payload: TokenPayload) => void) => {
        tokenListener = listener;
        return listenerHandle;
      },
    ),
    emitToken(token: string): void {
      tokenListener?.({ tokenResult: { token } });
    },
    listenerHandle,
  };
}

type LlamaPluginMock = ReturnType<typeof makePluginMock>;

let mockedPlugin: LlamaPluginMock | null = null;

function currentPlugin(): LlamaPluginMock {
  if (!mockedPlugin) {
    throw new Error("llama-cpp-capacitor mock was not configured");
  }
  return mockedPlugin;
}

const llamaCppProxy = {
  initContext(options: Parameters<LlamaPluginMock["initContext"]>[0]) {
    return currentPlugin().initContext(options);
  },
  releaseContext(options: Parameters<LlamaPluginMock["releaseContext"]>[0]) {
    return currentPlugin().releaseContext(options);
  },
  releaseAllContexts() {
    return currentPlugin().releaseAllContexts();
  },
  generateText(options: Parameters<LlamaPluginMock["generateText"]>[0]) {
    return currentPlugin().generateText(options);
  },
  stopCompletion(options: Parameters<LlamaPluginMock["stopCompletion"]>[0]) {
    return currentPlugin().stopCompletion(options);
  },
  addListener(
    event: Parameters<LlamaPluginMock["addListener"]>[0],
    listener: Parameters<LlamaPluginMock["addListener"]>[1],
  ) {
    return currentPlugin().addListener(event, listener);
  },
};

vi.mock("llama-cpp-capacitor", () => ({ LlamaCpp: llamaCppProxy }));

afterEach(() => {
  clearNativeCapacitor();
  mockedPlugin = null;
});

describe("@elizaos/capacitor-llama adapter", () => {
  it("rejects model loads outside native Capacitor", async () => {
    const plugin = makePluginMock();
    mockedPlugin = plugin;
    const { capacitorLlama } = await import("./index");

    await expect(
      capacitorLlama.load({ modelPath: "/models/test.gguf" }),
    ).rejects.toThrow("only available on iOS and Android");
    expect(plugin.initContext).not.toHaveBeenCalled();
  });

  it("loads, generates, streams tokens, and unloads through llama-cpp-capacitor", async () => {
    setNativeCapacitor("ios");
    const plugin = makePluginMock();
    mockedPlugin = plugin;
    const { capacitorLlama } = await import("./index");

    const tokens: Array<[string, number]> = [];
    const offToken = capacitorLlama.onToken((token, index) => {
      tokens.push([token, index]);
    });

    await capacitorLlama.load({
      modelPath: "/models/test.gguf",
      contextSize: 2048,
      useGpu: true,
      maxThreads: 4,
    });
    plugin.emitToken("h");
    const result = await capacitorLlama.generate({
      prompt: "Say hello",
      maxTokens: 16,
      temperature: 0.2,
      topP: 0.8,
      stream: true,
      stopSequences: ["</s>"],
    });
    offToken();
    await capacitorLlama.unload();

    expect(plugin.initContext).toHaveBeenCalledWith({
      contextId: 1,
      params: {
        model: "/models/test.gguf",
        n_ctx: 2048,
        n_gpu_layers: 99,
        n_threads: 4,
        use_mmap: true,
      },
    });
    expect(plugin.generateText).toHaveBeenCalledWith({
      contextId: 1,
      prompt: "Say hello",
      params: {
        n_predict: 16,
        temperature: 0.2,
        top_p: 0.8,
        stop: ["</s>"],
        emit_partial_completion: true,
      },
    });
    expect(result).toEqual({
      text: "hello",
      promptTokens: 3,
      outputTokens: 2,
      durationMs: 7,
    });
    expect(tokens).toEqual([["h", 1]]);
    expect(capacitorLlama.currentModelPath()).toBe(null);
    expect(plugin.releaseContext).toHaveBeenCalledWith({ contextId: 1 });
  });

  it("registers a localInferenceLoader service without private field casts", async () => {
    setNativeCapacitor("android");
    const plugin = makePluginMock();
    mockedPlugin = plugin;
    const { registerCapacitorLlamaLoader } = await import("./index");
    const services = new Map<string, unknown>();

    registerCapacitorLlamaLoader({
      registerService(name, impl) {
        services.set(name, impl);
      },
    });

    const loader = services.get("localInferenceLoader") as {
      loadModel(args: { modelPath: string }): Promise<void>;
      unloadModel(): Promise<void>;
      currentModelPath(): string | null;
      generate(args: { prompt: string }): Promise<string>;
    };

    await loader.loadModel({ modelPath: "/models/mobile.gguf" });
    expect(loader.currentModelPath()).toBe("/models/mobile.gguf");
    await expect(loader.generate({ prompt: "Hello" })).resolves.toBe("hello");
    await loader.unloadModel();
    expect(loader.currentModelPath()).toBe(null);
  });
});

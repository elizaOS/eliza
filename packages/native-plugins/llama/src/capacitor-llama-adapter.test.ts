import { describe, expect, it, vi } from "vitest";

interface InitContextCall {
  contextId: number;
  model: string;
}

interface CompletionCall {
  contextId: number;
  params: Record<string, unknown>;
}

interface EmbeddingCall {
  contextId: number;
}

interface ReleaseCall {
  contextId: number;
}

interface MockPluginState {
  initContextCalls: InitContextCall[];
  completionCalls: CompletionCall[];
  embeddingCalls: EmbeddingCall[];
  releaseCalls: ReleaseCall[];
  releaseAllCalls: number;
}

function installMockPlugin(): MockPluginState {
  const state: MockPluginState = {
    initContextCalls: [],
    completionCalls: [],
    embeddingCalls: [],
    releaseCalls: [],
    releaseAllCalls: 0,
  };

  vi.doMock("llama-cpp-capacitor", () => ({
    LlamaCpp: {
      initContext: vi.fn(
        async (options: { contextId: number; params: { model: string } }) => {
          state.initContextCalls.push({
            contextId: options.contextId,
            model: options.params.model,
          });
          return { contextId: options.contextId };
        },
      ),
      releaseContext: vi.fn(async (options: { contextId: number }) => {
        state.releaseCalls.push({ contextId: options.contextId });
      }),
      releaseAllContexts: vi.fn(async () => {
        state.releaseAllCalls += 1;
      }),
      completion: vi.fn(
        async (options: {
          contextId: number;
          params: Record<string, unknown>;
        }) => {
          state.completionCalls.push({
            contextId: options.contextId,
            params: options.params,
          });
          return {
            text: "ok",
            tokens_evaluated: 10,
            tokens_predicted: 20,
            timings: { predicted_ms: 100 },
          };
        },
      ),
      stopCompletion: vi.fn(async () => undefined),
      embedding: vi.fn(async (options: { contextId: number }) => {
        state.embeddingCalls.push({ contextId: options.contextId });
        return { embedding: [0.1, 0.2, 0.3] };
      }),
      tokenize: vi.fn(async () => ({ tokens: [1, 2, 3] })),
      addListener: vi.fn(async () => ({ remove: async () => undefined })),
      getHardwareInfo: vi.fn(async () => ({
        platform: "android",
        deviceModel: "Pixel 9a",
        totalRamGb: 8,
        availableRamGb: 4,
        cpuCores: 8,
        gpu: null,
        gpuSupported: false,
      })),
    },
  }));

  // Capacitor presence shim so isCapacitorNative() reports true.
  (globalThis as Record<string, unknown>).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  };

  return state;
}

describe("CapacitorLlamaAdapter context-id allocation (issue #7681)", () => {
  it("allocates distinct context ids for two separate adapter instances", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const mod = await import("./capacitor-llama-adapter");
    const { CapacitorLlamaAdapter } = mod;

    const chatAdapter = new CapacitorLlamaAdapter();
    const embeddingAdapter = new CapacitorLlamaAdapter();

    await chatAdapter.load({ modelPath: "/tmp/llama-3.2-3b.gguf" });
    await embeddingAdapter.load({ modelPath: "/tmp/bge-small-en-v1.5.gguf" });

    expect(state.initContextCalls).toHaveLength(2);
    const [chatInit, embedInit] = state.initContextCalls;
    expect(chatInit.contextId).not.toBe(embedInit.contextId);
    expect(chatInit.model).toBe("/tmp/llama-3.2-3b.gguf");
    expect(embedInit.model).toBe("/tmp/bge-small-en-v1.5.gguf");
  });

  it("routes generate() against the chat adapter's contextId, not the embedding one", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const chatAdapter = new CapacitorLlamaAdapter();
    const embeddingAdapter = new CapacitorLlamaAdapter();

    await chatAdapter.load({ modelPath: "/tmp/llama.gguf" });
    await embeddingAdapter.load({ modelPath: "/tmp/bge.gguf" });

    await chatAdapter.generate({ prompt: "hi" });
    await embeddingAdapter.embed({ input: "hi" });

    expect(state.completionCalls).toHaveLength(1);
    expect(state.embeddingCalls).toHaveLength(1);

    const chatInit = state.initContextCalls.find(
      (c) => c.model === "/tmp/llama.gguf",
    );
    const embedInit = state.initContextCalls.find(
      (c) => c.model === "/tmp/bge.gguf",
    );
    expect(chatInit).toBeDefined();
    expect(embedInit).toBeDefined();

    expect(state.completionCalls[0].contextId).toBe(chatInit?.contextId);
    expect(state.embeddingCalls[0].contextId).toBe(embedInit?.contextId);
    expect(state.completionCalls[0].contextId).not.toBe(
      state.embeddingCalls[0].contextId,
    );
  });

  it("does NOT call releaseAllContexts on load() — that would tear down sibling adapter instances", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const chatAdapter = new CapacitorLlamaAdapter();
    const embeddingAdapter = new CapacitorLlamaAdapter();

    await chatAdapter.load({ modelPath: "/tmp/llama.gguf" });
    await embeddingAdapter.load({ modelPath: "/tmp/bge.gguf" });

    // Loading two adapters back-to-back used to release-all; the fix
    // releases only the adapter's own contextId (if any) and leaves the
    // sibling's context intact.
    expect(state.releaseAllCalls).toBe(0);
  });

  it("reuses the same contextId for a single instance across reload", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/model-a.gguf" });
    const firstId = state.initContextCalls[0].contextId;
    await adapter.load({ modelPath: "/tmp/model-b.gguf" });
    const secondId = state.initContextCalls[1].contextId;

    expect(secondId).toBe(firstId);
    // It should have released its own context before reusing the id.
    expect(
      state.releaseCalls.find((r) => r.contextId === firstId),
    ).toBeDefined();
  });

  it("forwards structured guidance extensions to native completion params", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    const responseSkeleton = {
      id: "test-skeleton",
      spans: [
        { kind: "literal", text: '{"choice":' },
        { kind: "enum", key: "choice", values: ["A", "B"] },
      ],
    };
    const prefillPlan = {
      prefix: '{"choice":',
      runs: [],
      freeCount: 1,
      id: "test-skeleton",
    };

    await adapter.load({ modelPath: "/tmp/llama.gguf" });
    await adapter.generate({
      prompt: "pick one",
      grammar: 'root ::= "\\"A\\"" | "\\"B\\""',
      responseSkeleton,
      prefill: '{"choice":',
      spanSamplerPlan: {
        overrides: [{ spanIndex: 1, temperature: 0, topK: 1 }],
        strict: true,
      },
      elizaSchema: {
        skeleton: responseSkeleton,
        grammar: 'root ::= "\\"A\\"" | "\\"B\\""',
        prefillPlan,
        longNames: {},
        id: "test-skeleton",
      },
    });

    expect(state.completionCalls).toHaveLength(1);
    const params = state.completionCalls[0].params;
    expect(params.grammar).toBe('root ::= "\\"A\\"" | "\\"B\\""');
    expect(params.response_skeleton).toEqual(responseSkeleton);
    expect(params.eliza_response_skeleton).toEqual(responseSkeleton);
    expect(params.prefill).toBe('{"choice":');
    expect(params.eliza_prefill_plan).toEqual(prefillPlan);
    expect(params.eliza_span_samplers).toEqual({
      overrides: [{ span_index: 1, temperature: 0, top_k: 1 }],
      strict: true,
    });
  });
});

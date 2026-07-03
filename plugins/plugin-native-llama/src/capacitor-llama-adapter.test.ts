import { describe, expect, it, vi } from "vitest";

interface InitContextCall {
  contextId: number;
  model: string;
  params: Record<string, unknown>;
}

interface CompletionCall {
  contextId: number;
}

interface EmbeddingCall {
  contextId: number;
}

interface ReleaseCall {
  contextId: number;
}

interface SetSpecTypeCall {
  target: string;
  drafter: string;
  specType: string;
  draftMin: number;
  draftMax: number;
}

interface SetCacheTypeCall {
  cacheTypeK: string;
  cacheTypeV: string;
}

interface MockPluginState {
  initContextCalls: InitContextCall[];
  completionCalls: CompletionCall[];
  embeddingCalls: EmbeddingCall[];
  releaseCalls: ReleaseCall[];
  releaseAllCalls: number;
  setSpecTypeCalls: SetSpecTypeCall[];
  setCacheTypeCalls: SetCacheTypeCall[];
}

interface MockOptions {
  /** When true, include the fork-only setSpecType / setCacheType methods. */
  forkBuild?: boolean;
  /** Platform reported by Capacitor.getPlatform() + getHardwareInfo(). */
  platform?: "ios" | "android";
  /** Value of getHardwareInfo().isSimulator (iOS Simulator detection). */
  isSimulator?: boolean;
}

function installMockPlugin(opts: MockOptions = {}): MockPluginState {
  const state: MockPluginState = {
    initContextCalls: [],
    completionCalls: [],
    embeddingCalls: [],
    releaseCalls: [],
    releaseAllCalls: 0,
    setSpecTypeCalls: [],
    setCacheTypeCalls: [],
  };

  const baseMock: Record<string, unknown> = {
    initContext: vi.fn(
      async (options: {
        contextId: number;
        params: { model: string } & Record<string, unknown>;
      }) => {
        state.initContextCalls.push({
          contextId: options.contextId,
          model: options.params.model,
          params: { ...options.params },
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
    completion: vi.fn(async (options: { contextId: number }) => {
      state.completionCalls.push({ contextId: options.contextId });
      return {
        text: "ok",
        tokens_evaluated: 10,
        tokens_predicted: 20,
        timings: { predicted_ms: 100 },
      };
    }),
    stopCompletion: vi.fn(async () => undefined),
    embedding: vi.fn(async (options: { contextId: number }) => {
      state.embeddingCalls.push({ contextId: options.contextId });
      return { embedding: [0.1, 0.2, 0.3] };
    }),
    tokenize: vi.fn(async () => ({ tokens: [1, 2, 3] })),
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
    getHardwareInfo: vi.fn(async () =>
      opts.platform === "ios"
        ? {
            platform: "ios",
            deviceModel: opts.isSimulator ? "iPhone Simulator" : "iPhone17,2",
            totalRamGb: 8,
            availableRamGb: 4,
            cpuCores: 8,
            gpu: { backend: "metal", available: !opts.isSimulator },
            gpuSupported: true,
            ...(typeof opts.isSimulator === "boolean"
              ? { isSimulator: opts.isSimulator }
              : {}),
          }
        : {
            platform: "android",
            deviceModel: "Pixel 9a",
            totalRamGb: 8,
            availableRamGb: 4,
            cpuCores: 8,
            gpu: null,
            gpuSupported: false,
          },
    ),
  };

  if (opts.forkBuild) {
    baseMock.setSpecType = vi.fn(async (args: SetSpecTypeCall) => {
      state.setSpecTypeCalls.push(args);
    });
    baseMock.setCacheType = vi.fn(async (args: SetCacheTypeCall) => {
      state.setCacheTypeCalls.push(args);
    });
  }

  vi.doMock("llama-cpp-capacitor", () => ({ LlamaCpp: baseMock }));

  // Capacitor presence shim so isCapacitorNative() reports true.
  (globalThis as Record<string, unknown>).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => opts.platform ?? "android",
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

  it("defaults Android loads to CPU-safe params", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/android-eliza-1.gguf" });

    expect(state.initContextCalls).toHaveLength(1);
    expect(state.initContextCalls[0].params.n_gpu_layers).toBe(0);
    expect(state.initContextCalls[0].params.flash_attn).toBe(false);
  });

  it("applies Gemma-aware RAM defaults on a text (Eliza-1) load: mmap on, windowed SWA KV (#9033)", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/eliza-1-2b-128k.gguf" });

    expect(state.initContextCalls).toHaveLength(1);
    const params = state.initContextCalls[0].params;
    // Lever 3: never force --no-mmap for Gemma (PLE pages from disk).
    expect(params.use_mmap).toBe(true);
    // Lever 2: windowed SWA KV is the dominant KV saving on Gemma-4.
    expect(params.swa_full).toBe(false);
  });

  it("does NOT pin swa_full on an embedding (non-Gemma) load", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/bge-small-en-v1.5.gguf" });

    expect(state.initContextCalls).toHaveLength(1);
    const params = state.initContextCalls[0].params;
    expect(params.embedding).toBe(true);
    // Gemma-only lever; embedding contexts have no SWA layers, so the knob
    // is left at the binding default rather than pinned.
    expect(params.swa_full).toBeUndefined();
    // mmap-on is safe/universal and stays on.
    expect(params.use_mmap).toBe(true);
  });

  it("allows Android callers to opt into GPU params explicitly", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/android-vulkan.gguf", useGpu: true });

    expect(state.initContextCalls).toHaveLength(1);
    expect(state.initContextCalls[0].params.n_gpu_layers).toBe(99);
    expect(state.initContextCalls[0].params.flash_attn).toBe(true);
  });

  it("uses Metal (GPU) by default on a real iOS device", async () => {
    vi.resetModules();
    const state = installMockPlugin({ platform: "ios", isSimulator: false });
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/eliza-1.gguf" });

    expect(state.initContextCalls).toHaveLength(1);
    expect(state.initContextCalls[0].params.n_gpu_layers).toBe(99);
    expect(state.initContextCalls[0].params.flash_attn).toBe(true);
  });

  it("forces CPU on the iOS Simulator (no Metal GPU compute → GPU load hangs)", async () => {
    vi.resetModules();
    const state = installMockPlugin({ platform: "ios", isSimulator: true });
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    // Default load (iOS default would be GPU on) must fall back to CPU on the Simulator.
    await adapter.load({ modelPath: "/tmp/eliza-1.gguf" });
    // Even an explicit useGpu:true must not enable GPU layers on the Simulator.
    await adapter.load({ modelPath: "/tmp/eliza-1.gguf", useGpu: true });

    expect(state.initContextCalls).toHaveLength(2);
    for (const call of state.initContextCalls) {
      expect(call.params.n_gpu_layers).toBe(0);
      expect(call.params.flash_attn).toBe(false);
    }
  });

  it("caps hostile generation token counts and derives stable cache slots", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/llama.gguf" });
    await adapter.generate({
      prompt: "hi",
      maxTokens: Number.POSITIVE_INFINITY,
      cacheKey: "user:../../escape",
    });

    expect(state.completionCalls).toHaveLength(1);
    const params = (
      (await import("llama-cpp-capacitor")) as unknown as {
        LlamaCpp: {
          completion: { mock: { calls: Array<[unknown]> } };
        };
      }
    ).LlamaCpp.completion.mock.calls[0][0] as {
      params: Record<string, unknown>;
    };
    expect(params.params.n_predict).toBe(256);
    expect(params.params.cache_prompt).toBe(true);
    expect(typeof params.params.slot_id).toBe("number");
    expect(params.params.slot_id).toBeGreaterThanOrEqual(0);
    expect(params.params.slot_id).toBeLessThan(4);
  });
});

describe("CapacitorLlamaAdapter MTP + cache type wiring", () => {
  it("forwards draftModelPath / draftMin / draftMax through initContext params on stock builds", async () => {
    vi.resetModules();
    const state = installMockPlugin({ forkBuild: false });
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");
    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({
      modelPath: "/tmp/target.gguf",
      draftModelPath: "/tmp/drafter.gguf",
      draftMin: 2,
      draftMax: 5,
      draftContextSize: 2048,
    });
    expect(state.initContextCalls).toHaveLength(1);
    const params = state.initContextCalls[0].params;
    expect(params.draft_model).toBe("/tmp/drafter.gguf");
    expect(params.draft_min).toBe(2);
    expect(params.draft_max).toBe(5);
    expect(params.n_ctx_draft).toBe(2048);
    expect(state.setSpecTypeCalls).toHaveLength(0); // stock build — no fork bridge
  });

  it("auto-calls setSpecType after init on fork builds when draftModelPath is set", async () => {
    vi.resetModules();
    const state = installMockPlugin({ forkBuild: true });
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");
    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({
      modelPath: "/tmp/target.gguf",
      draftModelPath: "/tmp/drafter.gguf",
      draftMin: 1,
      draftMax: 4,
    });
    expect(state.setSpecTypeCalls).toHaveLength(1);
    expect(state.setSpecTypeCalls[0]).toMatchObject({
      target: "/tmp/target.gguf",
      drafter: "/tmp/drafter.gguf",
      specType: "mtp",
      draftMin: 1,
      draftMax: 4,
    });
  });

  it("does NOT call setSpecType when draftModelPath is missing, even on fork builds", async () => {
    vi.resetModules();
    const state = installMockPlugin({ forkBuild: true });
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");
    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/target.gguf" });
    expect(state.setSpecTypeCalls).toHaveLength(0);
  });

  it("forwards cacheTypeK / cacheTypeV through initContext and auto-calls setCacheType on fork builds", async () => {
    vi.resetModules();
    const state = installMockPlugin({ forkBuild: true });
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");
    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({
      modelPath: "/tmp/target.gguf",
      cacheTypeK: "q8_0",
      cacheTypeV: "q4_0",
    });
    expect(state.initContextCalls[0].params.cache_type_k).toBe("q8_0");
    expect(state.initContextCalls[0].params.cache_type_v).toBe("q4_0");
    expect(state.setCacheTypeCalls).toHaveLength(1);
    expect(state.setCacheTypeCalls[0]).toEqual({
      cacheTypeK: "q8_0",
      cacheTypeV: "q4_0",
    });
  });

  it("does NOT throw when the fork bridge setSpecType rejects — only warns and continues", async () => {
    vi.resetModules();
    const state = installMockPlugin({ forkBuild: true });
    // Override setSpecType to reject.
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");
    const adapter = new CapacitorLlamaAdapter();

    // Replace the mock fn after import so we observe the rejection path.
    const llamaCppCapacitor = await import("llama-cpp-capacitor");
    const plugin = (
      llamaCppCapacitor as unknown as { LlamaCpp: { setSpecType: unknown } }
    ).LlamaCpp;
    (plugin as { setSpecType: unknown }).setSpecType = vi.fn(async () => {
      throw new Error("simulated fork bridge error");
    });

    await expect(
      adapter.load({
        modelPath: "/tmp/target.gguf",
        draftModelPath: "/tmp/drafter.gguf",
      }),
    ).resolves.not.toThrow();
    // initContext should have completed successfully — load() does not
    // abort just because the secondary spec-type bridge rejected.
    expect(state.initContextCalls).toHaveLength(1);
  });

  it("setSpecType TS method warns and skips when underlying plugin lacks the method (stock build)", async () => {
    vi.resetModules();
    installMockPlugin({ forkBuild: false });
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");
    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/target.gguf" });
    // Direct call should not throw — falls through to the warn-and-skip path.
    await expect(
      adapter.setSpecType({
        target: "/tmp/target.gguf",
        drafter: "/tmp/drafter.gguf",
        specType: "mtp",
        draftMin: 1,
        draftMax: 3,
      }),
    ).resolves.toBeUndefined();
  });
});

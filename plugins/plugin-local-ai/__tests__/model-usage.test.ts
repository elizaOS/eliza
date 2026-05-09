import { describe, expect, it, vi } from "vitest";

const config = {
  CACHE_DIR: "/tmp/eliza-local-ai-test-cache",
  LOCAL_EMBEDDING_DIMENSIONS: "384",
  LOCAL_EMBEDDING_MODEL: "embed.gguf",
  LOCAL_LARGE_MODEL: "large.gguf",
  LOCAL_SMALL_MODEL: "small.gguf",
  MODELS_DIR: "/tmp/eliza-local-ai-test-models",
};

vi.mock("../environment", () => ({
  validateConfig: vi.fn(() => config),
}));

vi.mock("../utils/downloadManager", () => ({
  DownloadManager: {
    getInstance: vi.fn(() => ({
      downloadModel: vi.fn(async () => true),
    })),
  },
}));

vi.mock("../utils/platform", () => ({
  getPlatformManager: vi.fn(() => ({
    getCapabilities: vi.fn(() => ({
      gpu: { type: "mock" },
      platform: "test",
      recommendedModelSize: "small",
      supportedBackends: ["mock"],
    })),
    initialize: vi.fn(async () => undefined),
  })),
}));

vi.mock("../utils/tokenizerManager", () => ({
  TokenizerManager: {
    getInstance: vi.fn(() => ({
      decode: vi.fn(async (tokens: number[]) => tokens.join(" ")),
      encode: vi.fn(async (text: string) => Array(Math.max(1, Math.ceil(text.length / 4))).fill(1)),
    })),
  },
}));

vi.mock("../utils/transcribeManager", () => ({
  TranscribeManager: {
    getInstance: vi.fn(() => ({
      ensureFFmpeg: vi.fn(async () => true),
      transcribe: vi.fn(async () => ({ text: "transcribed" })),
    })),
  },
}));

vi.mock("../utils/ttsManager", () => ({
  TTSManager: {
    getInstance: vi.fn(() => ({
      generateSpeech: vi.fn(async () => ({ on: vi.fn() })),
    })),
  },
}));

vi.mock("../utils/visionManager", () => ({
  VisionManager: {
    getInstance: vi.fn(() => ({
      processImage: vi.fn(async () => ({ description: "description", title: "title" })),
    })),
  },
}));

vi.mock("node-llama-cpp", () => {
  const fakeContext = {
    dispose: vi.fn(),
    getSequence: vi.fn(() => ({})),
  };
  const fakeModel = {
    createContext: vi.fn(async () => fakeContext),
    createEmbeddingContext: vi.fn(async () => ({
      getEmbeddingFor: vi.fn(async () => ({ vector: [1, 2, 3] })),
    })),
    tokenize: vi.fn(() => []),
  };

  class LlamaChatSession {
    prompt = vi.fn(async (prompt: string, options?: { maxTokens?: number }) => {
      if (options?.maxTokens === 1) return "";
      if (prompt.includes("Respond with JSON only")) {
        return JSON.stringify({ thought: "ok", text: "local result" });
      }
      return "thought: ok\ntext: local result";
    });
  }

  return {
    getLlama: vi.fn(async () => ({
      loadModel: vi.fn(async () => fakeModel),
    })),
    LlamaChatSession,
  };
});

function createRuntime(settings: Record<string, string> = {}) {
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  };
}

describe("local-ai MODEL_USED events", () => {
  it("emits estimated usage with text, object, and embedding model types", async () => {
    const { localAiPlugin } = await import("../index.js");
    const runtime = createRuntime(config);

    await localAiPlugin.models?.TEXT_SMALL?.(runtime as never, {
      prompt: "small prompt",
      stopSequences: [],
    });
    await localAiPlugin.models?.TEXT_LARGE?.(runtime as never, {
      prompt: "large prompt",
      stopSequences: [],
    });
    await localAiPlugin.models?.OBJECT_SMALL?.(runtime as never, {
      prompt: "object prompt",
    });
    await localAiPlugin.models?.TEXT_EMBEDDING?.(runtime as never, {
      text: "embed prompt",
    });

    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      1,
      "MODEL_USED",
      expect.objectContaining({
        source: "local-ai",
        type: "TEXT_SMALL",
        model: "small.gguf",
        usageEstimated: true,
        tokens: expect.objectContaining({ estimated: true }),
      })
    );
    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      2,
      "MODEL_USED",
      expect.objectContaining({
        source: "local-ai",
        type: "TEXT_LARGE",
        model: "large.gguf",
        usageEstimated: true,
        tokens: expect.objectContaining({ estimated: true }),
      })
    );
    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      3,
      "MODEL_USED",
      expect.objectContaining({
        source: "local-ai",
        type: "OBJECT_SMALL",
        model: "small.gguf",
        usageEstimated: true,
        tokens: expect.objectContaining({ estimated: true }),
      })
    );
    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      4,
      "MODEL_USED",
      expect.objectContaining({
        source: "local-ai",
        type: "TEXT_EMBEDDING",
        model: "embed.gguf",
        usageEstimated: true,
        tokens: expect.objectContaining({ completion: 0, estimated: true }),
      })
    );
  }, 180_000);
});

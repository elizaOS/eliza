import { afterEach, describe, expect, it, vi } from "vitest";

type KernelModule = typeof import("./ios-local-agent-kernel");

type MockOptions = {
  hardware?: Record<string, unknown>;
  availableModels?: Array<{ name?: string; path?: string; size?: number }>;
  downloadModel?: ReturnType<typeof vi.fn>;
  getDownloadProgress?: ReturnType<typeof vi.fn>;
  load?: ReturnType<typeof vi.fn>;
  generate?: ReturnType<typeof vi.fn>;
};

function stubLocalStorage(): Storage {
  const items = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => items.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      items.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      items.delete(key);
    }),
    clear: vi.fn(() => {
      items.clear();
    }),
    key: vi.fn((index: number) => [...items.keys()][index] ?? null),
    get length() {
      return items.size;
    },
  } as Storage;
}

async function loadKernel(options: MockOptions = {}): Promise<KernelModule> {
  vi.resetModules();
  const localStorage = stubLocalStorage();
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("navigator", { hardwareConcurrency: 8 });

  const load =
    options.load ??
    vi.fn(async (_options: Record<string, unknown>) => undefined);
  const generate =
    options.generate ??
    vi.fn(async () => ({
      text: "native answer",
      promptTokens: 4,
      outputTokens: 2,
      durationMs: 10,
    }));

  vi.doMock("@elizaos/capacitor-llama", () => ({
    capacitorLlama: {
      getHardwareInfo: vi.fn(async () => ({
        platform: "ios",
        deviceModel: "iPhone16,1",
        machineId: "iPhone16,1",
        osVersion: "26.3.1",
        isSimulator: false,
        totalRamGb: 8,
        availableRamGb: 5,
        freeStorageGb: 64,
        cpuCores: 8,
        gpu: { backend: "metal", available: true },
        gpuSupported: true,
        dflashSupported: true,
        source: "native",
        ...options.hardware,
      })),
      isLoaded: vi.fn(async () => ({ loaded: false, modelPath: null })),
      currentModelPath: vi.fn(() => null),
      load,
      generate,
    },
  }));

  vi.doMock("llama-cpp-capacitor", () => ({
    downloadModel:
      options.downloadModel ??
      vi.fn(async (_url: string, filename: string) => ({
        path: `/models/${filename}`,
      })),
    getDownloadProgress:
      options.getDownloadProgress ??
      vi.fn(async () => ({
        downloaded: 0,
        total: 0,
        percentage: 0,
        bytesPerSec: 0,
        etaMs: null,
      })),
    cancelDownload: vi.fn(async () => true),
    getAvailableModels: vi.fn(async () => options.availableModels ?? []),
  }));

  return import("./ios-local-agent-kernel");
}

async function jsonRequest(
  kernel: KernelModule,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<unknown> {
  const response = await kernel.handleIosLocalAgentRequest(
    new Request(`http://127.0.0.1:31337${pathname}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  expect(response.status).toBeLessThan(400);
  return response.json();
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

describe("iOS local-agent local inference flow", () => {
  afterEach(() => {
    vi.doUnmock("@elizaos/capacitor-llama");
    vi.doUnmock("llama-cpp-capacitor");
    vi.unstubAllGlobals();
  });

  it("answers with local model download status while queueing target and DFlash drafter", async () => {
    const downloadModel = vi.fn(async (_url: string, filename: string) => ({
      path: `/models/${filename}`,
    }));
    const kernel = await loadKernel({ downloadModel });

    const created = (await jsonRequest(kernel, "POST", "/api/conversations", {
      title: "Download test",
    })) as { conversation: { id: string } };

    const reply = (await jsonRequest(
      kernel,
      "POST",
      `/api/conversations/${created.conversation.id}/messages`,
      { text: "hello" },
    )) as {
      text: string;
      localInference?: { status?: string; modelId?: string | null };
    };

    expect(reply.localInference).toMatchObject({
      status: "downloading",
      modelId: "qwen3.5-4b-dflash",
    });
    expect(reply.text.toLowerCase()).toContain("downloading");

    await eventually(() => {
      const filenames = downloadModel.mock.calls.map((call) => call[1]);
      expect(filenames).toContain("qwen3.5-4b-dflash.gguf");
      expect(filenames).toContain("qwen3.5-4b-dflash-drafter-q4.gguf");
    });
  }, 10_000);

  it("passes DFlash drafter options into the native iOS load call when companion is installed", async () => {
    const load = vi.fn(async (_options: Record<string, unknown>) => undefined);
    const kernel = await loadKernel({
      load,
      availableModels: [
        {
          name: "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
          path: "/models/Qwen_Qwen3.5-4B-Q4_K_M.gguf",
          size: 2_500_000_000,
        },
        {
          name: "Qwen3.5-4B-DFlash-Q4_K_M.gguf",
          path: "/models/Qwen3.5-4B-DFlash-Q4_K_M.gguf",
          size: 510_000_000,
        },
      ],
    });

    await jsonRequest(kernel, "POST", "/api/local-inference/active", {
      modelId: "qwen3.5-4b-dflash",
    });

    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPath: "/models/Qwen_Qwen3.5-4B-Q4_K_M.gguf",
        draftModelPath: "/models/Qwen3.5-4B-DFlash-Q4_K_M.gguf",
        draftContextSize: 256,
        draftMin: 1,
        draftMax: 16,
        mobileSpeculative: true,
        speculativeSamples: 4,
        useGpu: true,
      }),
    );
  });

  it("does not pass a drafter to native iOS load when the runtime reports no DFlash support", async () => {
    const load = vi.fn(async (_options: Record<string, unknown>) => undefined);
    const kernel = await loadKernel({
      load,
      hardware: {
        dflashSupported: false,
        dflashReason: "test runtime without DFlash symbols",
      },
      availableModels: [
        {
          name: "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
          path: "/models/Qwen_Qwen3.5-4B-Q4_K_M.gguf",
          size: 2_500_000_000,
        },
        {
          name: "Qwen3.5-4B-DFlash-Q4_K_M.gguf",
          path: "/models/Qwen3.5-4B-DFlash-Q4_K_M.gguf",
          size: 510_000_000,
        },
      ],
    });

    await jsonRequest(kernel, "POST", "/api/local-inference/active", {
      modelId: "qwen3.5-4b-dflash",
    });

    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPath: "/models/Qwen_Qwen3.5-4B-Q4_K_M.gguf",
        useGpu: true,
      }),
    );
    expect(load.mock.calls[0]?.[0]).not.toHaveProperty("draftModelPath");
  });
});

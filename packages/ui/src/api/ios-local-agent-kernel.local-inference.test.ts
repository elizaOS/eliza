import { afterEach, describe, expect, it, vi } from "vitest";

type KernelModule = Pick<
  typeof import("./ios-local-agent-kernel"),
  "handleIosLocalAgentRequest"
>;

type DownloadModelFn = (
  _url: string,
  filename: string,
) => Promise<{ path: string }>;
type GetDownloadProgressFn = (_url: string) => Promise<{
  downloaded: number;
  total: number;
  percentage: number;
  bytesPerSec: number;
  etaMs: null;
}>;
type LoadFn = (_options: Record<string, unknown>) => Promise<undefined>;
type GenerateFn = (_options: Record<string, unknown>) => Promise<{
  text: string;
  promptTokens: number;
  outputTokens: number;
  durationMs: number;
}>;

type MockOptions = {
  hardware?: Record<string, unknown>;
  availableModels?: Array<{ name?: string; path?: string; size?: number }>;
  downloadModel?: DownloadModelFn;
  getDownloadProgress?: GetDownloadProgressFn;
  load?: LoadFn;
  generate?: GenerateFn;
};

const mockState = vi.hoisted(
  (): {
    hardware: Record<string, unknown>;
    availableModels: Array<{ name?: string; path?: string; size?: number }>;
    downloadModel: DownloadModelFn;
    getDownloadProgress: GetDownloadProgressFn;
    load: LoadFn;
    generate: GenerateFn;
  } => ({
    hardware: {},
    availableModels: [],
    downloadModel: vi.fn(async (_url: string, filename: string) => ({
      path: `/models/${filename}`,
    })),
    getDownloadProgress: vi.fn(async (_url: string) => ({
      downloaded: 0,
      total: 0,
      percentage: 0,
      bytesPerSec: 0,
      etaMs: null,
    })),
    load: vi.fn(async (_options: Record<string, unknown>) => undefined),
    generate: vi.fn(async (_options: Record<string, unknown>) => ({
      text: "native answer",
      promptTokens: 4,
      outputTokens: 2,
      durationMs: 10,
    })),
  }),
);

vi.mock("@elizaos/capacitor-llama", () => ({
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
      ...mockState.hardware,
    })),
    isLoaded: vi.fn(async () => ({ loaded: false, modelPath: null })),
    currentModelPath: vi.fn(() => null),
    load: (options: Record<string, unknown>) => mockState.load(options),
    generate: (options: Record<string, unknown>) => mockState.generate(options),
  },
}));

vi.mock("llama-cpp-capacitor", () => ({
  downloadModel: (url: string, filename: string) =>
    mockState.downloadModel(url, filename),
  getDownloadProgress: (url: string) => mockState.getDownloadProgress(url),
  cancelDownload: vi.fn(async () => true),
  getAvailableModels: vi.fn(async () => mockState.availableModels),
}));

import { handleIosLocalAgentRequest } from "./ios-local-agent-kernel";

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
  mockState.hardware = options.hardware ?? {};
  mockState.availableModels = options.availableModels ?? [];
  mockState.downloadModel =
    options.downloadModel ??
    vi.fn(async (_url: string, filename: string) => ({
      path: `/models/${filename}`,
    }));
  mockState.getDownloadProgress =
    options.getDownloadProgress ??
    vi.fn(async (_url: string) => ({
      downloaded: 0,
      total: 0,
      percentage: 0,
      bytesPerSec: 0,
      etaMs: null,
    }));
  mockState.load =
    options.load ??
    vi.fn(async (_options: Record<string, unknown>) => undefined);
  mockState.generate =
    options.generate ??
    vi.fn(async (_options: Record<string, unknown>) => ({
      text: "native answer",
      promptTokens: 4,
      outputTokens: 2,
      durationMs: 10,
    }));

  const localStorage = stubLocalStorage();
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("navigator", { hardwareConcurrency: 8 });

  await handleIosLocalAgentRequest(
    new Request("http://127.0.0.1:31337/api/agent/reset", {
      method: "POST",
      body: "{}",
    }),
  );
  return { handleIosLocalAgentRequest };
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
  afterEach(async () => {
    await handleIosLocalAgentRequest(
      new Request("http://127.0.0.1:31337/api/agent/reset", {
        method: "POST",
        body: "{}",
      }),
    ).catch(() => undefined);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
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
  }, 30_000);

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

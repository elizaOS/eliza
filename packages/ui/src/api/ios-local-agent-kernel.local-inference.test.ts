import { afterEach, describe, expect, it, vi } from "vitest";

type KernelModule = Pick<
  typeof import("./ios-local-agent-kernel"),
  "handleIosLocalAgentRequest"
>;

type DownloadModelFn = (
  _url: string,
  filename: string,
) => Promise<{ path: string }>;
type HashFileFn = (
  path: string,
) => Promise<{ sha256: string; sizeBytes: number }>;
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
  hashFile?: HashFileFn;
  getDownloadProgress?: GetDownloadProgressFn;
  load?: LoadFn;
  generate?: GenerateFn;
};

function eliza1MobileManifest(): Record<string, unknown> {
  return {
    id: "eliza-1-1_7b",
    version: "1.0.0",
    defaultEligible: true,
    files: {
      text: [
        {
          path: "text/eliza-1-1_7b-32k.gguf",
          sha256: "0".repeat(64),
          ctx: 32768,
        },
      ],
      voice: [
        {
          path: "voice/eliza-voice.codec",
          sha256: "0".repeat(64),
        },
      ],
      asr: [
        {
          path: "asr/eliza-asr.codec",
          sha256: "0".repeat(64),
        },
      ],
      vision: [],
      dflash: [
        {
          path: "dflash/drafter-1_7b.gguf",
          sha256: "0".repeat(64),
          ctx: 32768,
        },
      ],
      cache: [
        {
          path: "cache/eliza-1-1_7b.kvcache",
          sha256: "0".repeat(64),
        },
      ],
      vad: [
        {
          path: "vad/eliza-vad.bin",
          sha256: "0".repeat(64),
        },
      ],
    },
  };
}

const mockState = vi.hoisted(
  (): {
    hardware: Record<string, unknown>;
    availableModels: Array<{ name?: string; path?: string; size?: number }>;
    downloadModel: DownloadModelFn;
    hashFile: HashFileFn;
    getDownloadProgress: GetDownloadProgressFn;
    load: LoadFn;
    generate: GenerateFn;
  } => ({
    hardware: {},
    availableModels: [],
    downloadModel: vi.fn(async (_url: string, filename: string) => ({
      path: `/models/${filename}`,
    })),
    hashFile: vi.fn(async () => ({
      sha256: "0".repeat(64),
      sizeBytes: 1024,
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
  hashFile: (path: string) => mockState.hashFile(path),
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
  mockState.hashFile =
    options.hashFile ??
    vi.fn(async () => ({
      sha256: "0".repeat(64),
      sizeBytes: 1024,
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(eliza1MobileManifest(), {
        status: 200,
      }),
    ),
  );

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

async function eventually(
  assertion: () => void | Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      await assertion();
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

  it("answers with local model download status while queueing the recommended target", async () => {
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
      modelId: "eliza-1-1_7b",
    });
    expect(reply.text.toLowerCase()).toContain("downloading");

    await eventually(() => {
      const filenames = downloadModel.mock.calls.map((call) => call[1]);
      expect(filenames).toContain("eliza-1-1_7b.manifest.json");
      expect(filenames).toContain("eliza-1-1_7b-32k.gguf");
      expect(mockState.hashFile).toHaveBeenCalledWith(
        "/models/eliza-1-1_7b.manifest.json",
      );
      expect(mockState.hashFile).toHaveBeenCalledWith(
        "/models/eliza-1-1_7b-32k.gguf",
      );
    });
  }, 30_000);

  it("warns from greeting when the default local model still needs download", async () => {
    const kernel = await loadKernel();

    const created = (await jsonRequest(kernel, "POST", "/api/conversations", {
      title: "Greeting test",
    })) as { conversation: { id: string } };

    const greeting = (await jsonRequest(
      kernel,
      "POST",
      `/api/conversations/${created.conversation.id}/greeting`,
    )) as {
      text: string;
      localInference?: { status?: string; modelId?: string | null };
    };

    expect(greeting.text).not.toContain("I'm running locally on this device.");
    expect(greeting.text.toLowerCase()).toContain("downloading");
    expect(greeting.localInference).toMatchObject({
      status: "downloading",
      modelId: "eliza-1-1_7b",
    });
  });

  it("fails an Eliza-1 bundle download when a native SHA256 check mismatches", async () => {
    const kernel = await loadKernel({
      hashFile: vi.fn(async (path: string) => ({
        sha256: path.endsWith(".manifest.json")
          ? "0".repeat(64)
          : "f".repeat(64),
        sizeBytes: 1024,
      })),
    });

    await jsonRequest(kernel, "POST", "/api/local-inference/downloads", {
      modelId: "eliza-1-1_7b",
    });

    await eventually(async () => {
      const response = await kernel.handleIosLocalAgentRequest(
        new Request(
          "http://127.0.0.1:31337/api/local-inference/downloads/eliza-1-1_7b",
        ),
      );
      const payload = (await response.json()) as {
        job?: { state?: string; error?: string };
      };
      expect(payload.job?.state).toBe("failed");
      expect(payload.job?.error).toContain("SHA256 mismatch");
    });
  });

  it("uses a simulator RAM fallback when native hardware omits memory", async () => {
    const kernel = await loadKernel({
      hardware: {
        totalRamGb: undefined,
        availableRamGb: undefined,
        isSimulator: true,
      },
    });

    const created = (await jsonRequest(kernel, "POST", "/api/conversations", {
      title: "Simulator memory fallback",
    })) as { conversation: { id: string } };

    const reply = (await jsonRequest(
      kernel,
      "POST",
      `/api/conversations/${created.conversation.id}/messages`,
      { text: "download the default local model" },
    )) as {
      text: string;
      localInference?: { status?: string; modelId?: string | null };
    };

    expect(reply.localInference).toMatchObject({
      status: "downloading",
      modelId: "eliza-1-1_7b",
    });
  });

  it("passes mobile load options into the native iOS load call when the recommended model is installed", async () => {
    const load = vi.fn(async (_options: Record<string, unknown>) => undefined);
    const kernel = await loadKernel({
      load,
      availableModels: [
        {
          name: "eliza-1-1_7b-32k.gguf",
          path: "/models/eliza-1-1_7b-32k.gguf",
          size: 1_200_000_000,
        },
      ],
    });

    await jsonRequest(kernel, "POST", "/api/local-inference/active", {
      modelId: "eliza-1-1_7b",
    });

    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPath: "/models/eliza-1-1_7b-32k.gguf",
        contextSize: 6144,
        maxThreads: 6,
        useGpu: true,
      }),
    );
    expect(load.mock.calls[0]?.[0]).not.toHaveProperty("draftModelPath");
  });

  it("does not pass a drafter to native iOS load for the current Eliza-1 mobile catalog", async () => {
    const load = vi.fn(async (_options: Record<string, unknown>) => undefined);
    const kernel = await loadKernel({
      load,
      hardware: {
        dflashSupported: true,
      },
      availableModels: [
        {
          name: "eliza-1-1_7b-32k.gguf",
          path: "/models/eliza-1-1_7b-32k.gguf",
          size: 1_200_000_000,
        },
      ],
    });

    await jsonRequest(kernel, "POST", "/api/local-inference/active", {
      modelId: "eliza-1-1_7b",
    });

    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPath: "/models/eliza-1-1_7b-32k.gguf",
        useGpu: true,
      }),
    );
    expect(load.mock.calls[0]?.[0]).not.toHaveProperty("draftModelPath");
  });
});

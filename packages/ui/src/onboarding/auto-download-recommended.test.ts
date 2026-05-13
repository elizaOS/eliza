import { afterEach, describe, expect, it, vi } from "vitest";

const mockClient = vi.hoisted(() => ({
  getLocalInferenceHub: vi.fn(),
  startLocalInferenceDownload: vi.fn(),
}));

vi.mock("../api", () => ({
  client: mockClient,
}));

import { MODEL_CATALOG } from "../services/local-inference/catalog";
import type { ModelHubSnapshot } from "../services/local-inference/types";
import { autoDownloadRecommendedLocalModelInBackground } from "./auto-download-recommended";

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

function simulatorSnapshot(): ModelHubSnapshot {
  return {
    catalog: MODEL_CATALOG,
    installed: [],
    active: { modelId: null, loadedAt: null, status: "idle" },
    downloads: [],
    assignments: {},
    hardware: {
      platform: "ios",
      arch: "arm64",
      totalRamGb: 8,
      freeRamGb: 5,
      gpu: { backend: "metal", totalVramGb: 0, freeVramGb: 0 },
      cpuCores: 8,
      appleSilicon: true,
      recommendedBucket: "small",
      source: "os-fallback",
      mobile: {
        platform: "ios",
        isSimulator: true,
        availableRamGb: 5,
        freeStorageGb: 64,
        gpuSupported: true,
        dflashSupported: true,
        source: "native",
      },
    },
    textReadiness: {
      updatedAt: new Date(0).toISOString(),
      slots: {} as ModelHubSnapshot["textReadiness"]["slots"],
    },
  } as unknown as ModelHubSnapshot;
}

describe("autoDownloadRecommendedLocalModelInBackground", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("queues the fit-aware recommended default model on iOS simulator hardware", async () => {
    vi.stubGlobal("window", { localStorage: stubLocalStorage() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    mockClient.getLocalInferenceHub.mockResolvedValue(simulatorSnapshot());
    mockClient.startLocalInferenceDownload.mockResolvedValue({ ok: true });

    await autoDownloadRecommendedLocalModelInBackground(
      "http://127.0.0.1:31337",
    );

    // Per the 2026-05-12 Qwen3.5 directive, the mobile TEXT_LARGE ladder
    // leads with eliza-1-1_7b (Qwen3.5-2B-Base, minRamGb 4, sizeGb 1.4)
    // before the deprecated Qwen3 eliza-1-1_7b — on a 8 GB iOS simulator
    // eliza-1-1_7b fits and is the queued default.
    expect(mockClient.startLocalInferenceDownload).toHaveBeenCalledWith(
      "eliza-1-1_7b",
    );
  });
});

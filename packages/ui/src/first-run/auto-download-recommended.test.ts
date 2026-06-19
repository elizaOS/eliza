import { afterEach, describe, expect, it, vi } from "vitest";

const mockClient = vi.hoisted(() => ({
  getLocalInferenceHub: vi.fn(),
  setLocalInferenceActive: vi.fn(),
  startLocalInferenceDownload: vi.fn(),
}));

const fetchWithCsrfMock = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({
  client: mockClient,
}));

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: fetchWithCsrfMock,
}));

import { MODEL_CATALOG } from "../services/local-inference/catalog";
import type { ModelHubSnapshot } from "../services/local-inference/types";
import { autoDownloadRecommendedLocalModelInBackground } from "./auto-download-recommended";

function fakeLocalStorage(): Storage {
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
        mtpSupported: true,
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
    vi.stubGlobal("window", { localStorage: fakeLocalStorage() });
    fetchWithCsrfMock.mockResolvedValue(new Response("ok", { status: 200 }));
    mockClient.getLocalInferenceHub.mockResolvedValue(simulatorSnapshot());
    mockClient.startLocalInferenceDownload.mockResolvedValue({ ok: true });

    await autoDownloadRecommendedLocalModelInBackground(
      "http://127.0.0.1:31337",
    );

    expect(mockClient.startLocalInferenceDownload).toHaveBeenCalledWith(
      "eliza-1-2b",
    );
  });

  it("activates an installed Eliza download bundle instead of only marking setup attempted", async () => {
    const snapshot = simulatorSnapshot();
    snapshot.installed = [
      {
        id: "eliza-1-0_8b",
        displayName: "eliza-1-0.8B",
        path: "/models/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf",
        sizeBytes: 556_982_432,
        installedAt: new Date(0).toISOString(),
        source: "eliza-download",
      },
    ] as ModelHubSnapshot["installed"];

    vi.stubGlobal("window", { localStorage: fakeLocalStorage() });
    fetchWithCsrfMock.mockResolvedValue(new Response("ok", { status: 200 }));
    mockClient.getLocalInferenceHub.mockResolvedValue(snapshot);
    mockClient.setLocalInferenceActive.mockResolvedValue({ status: "ready" });

    await autoDownloadRecommendedLocalModelInBackground(
      "http://127.0.0.1:31337",
    );

    expect(mockClient.setLocalInferenceActive).toHaveBeenCalledWith(
      "eliza-1-0_8b",
    );
    expect(mockClient.startLocalInferenceDownload).not.toHaveBeenCalled();
  });

  it("does not re-activate an installed bundle that is already ready", async () => {
    const snapshot = simulatorSnapshot();
    snapshot.installed = [
      {
        id: "eliza-1-0_8b",
        displayName: "eliza-1-0.8B",
        path: "/models/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf",
        sizeBytes: 556_982_432,
        installedAt: new Date(0).toISOString(),
        source: "eliza-download",
      },
    ] as ModelHubSnapshot["installed"];
    snapshot.active = {
      modelId: "eliza-1-0_8b",
      loadedAt: new Date(0).toISOString(),
      status: "ready",
    };

    vi.stubGlobal("window", { localStorage: fakeLocalStorage() });
    fetchWithCsrfMock.mockResolvedValue(new Response("ok", { status: 200 }));
    mockClient.getLocalInferenceHub.mockResolvedValue(snapshot);

    await autoDownloadRecommendedLocalModelInBackground(
      "http://127.0.0.1:31337",
    );

    expect(mockClient.setLocalInferenceActive).not.toHaveBeenCalled();
    expect(mockClient.startLocalInferenceDownload).not.toHaveBeenCalled();
  });
});

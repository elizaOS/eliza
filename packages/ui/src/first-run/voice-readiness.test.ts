import { beforeEach, describe, expect, it, vi } from "vitest";

const mockClient = vi.hoisted(() => ({
  getLocalInferenceActive: vi.fn(),
  getLocalInferenceHub: vi.fn(),
  setLocalInferenceActive: vi.fn(),
  startLocalInferenceDownload: vi.fn(),
}));
const fetchWithCsrfMock = vi.hoisted(() => vi.fn());

const asrSupport = vi.hoisted(() => ({ supported: true }));

vi.mock("../api", () => ({
  client: mockClient,
}));

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: fetchWithCsrfMock,
}));

vi.mock("../platform/init", () => ({
  isAndroid: false,
  isIOS: false,
  isDesktopPlatform: () => true,
}));

vi.mock("../utils", () => ({
  getElizaApiBase: () => "http://127.0.0.1:31337",
  resolveApiUrl: (path: string) => path,
}));

vi.mock("../voice/local-asr-capture", () => ({
  isLocalAsrCaptureSupported: () => asrSupport.supported,
}));

import { prepareFirstRunVoiceAndTranscription } from "./voice-readiness";

function hubSnapshot(
  installed: Array<{ id: string; source: string; bundleRoot?: string }> = [],
) {
  return {
    catalog: [],
    installed,
    active: { modelId: null, loadedAt: null, status: "idle" },
    downloads: [],
    assignments: {},
    hardware: {
      platform: "darwin",
      arch: "arm64",
      totalRamGb: 16,
      freeRamGb: 8,
      gpu: { backend: "metal", totalVramGb: 0, freeVramGb: 0 },
      cpuCores: 8,
      appleSilicon: true,
      recommendedBucket: "small",
      source: "os-fallback",
    },
    textReadiness: {
      updatedAt: new Date(0).toISOString(),
      slots: {},
    },
  };
}

describe("prepareFirstRunVoiceAndTranscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asrSupport.supported = true;
    fetchWithCsrfMock.mockResolvedValue(
      Response.json({ ready: false, provider: null }),
    );
  });

  it("does not start model downloads while checking first-run voice", async () => {
    mockClient.getLocalInferenceActive.mockResolvedValue({
      status: "idle",
      modelId: null,
    });
    mockClient.getLocalInferenceHub.mockResolvedValue(hubSnapshot());

    const readiness = await prepareFirstRunVoiceAndTranscription();

    expect(readiness.status).toBe("preparing");
    expect(mockClient.startLocalInferenceDownload).not.toHaveBeenCalled();
  });

  it("treats staged packaged ASR as voice-ready without an active Eliza-1 bundle", async () => {
    mockClient.getLocalInferenceActive.mockResolvedValue({
      status: "idle",
      modelId: null,
    });
    fetchWithCsrfMock.mockResolvedValue(
      Response.json({ ready: true, provider: "whisper-cpp" }),
    );

    const readiness = await prepareFirstRunVoiceAndTranscription();

    expect(readiness.status).toBe("ready");
    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/asr/local-inference/status",
      { method: "GET" },
    );
    expect(mockClient.getLocalInferenceHub).not.toHaveBeenCalled();
    expect(mockClient.startLocalInferenceDownload).not.toHaveBeenCalled();
  });

  it("activates an already-staged local bundle", async () => {
    mockClient.getLocalInferenceActive.mockResolvedValue({
      status: "idle",
      modelId: null,
    });
    mockClient.getLocalInferenceHub.mockResolvedValue(
      hubSnapshot([
        {
          id: "eliza-1-0_8b",
          source: "eliza-download",
          bundleRoot: "/tmp/models/eliza-1-0_8b.bundle",
        },
      ]),
    );
    mockClient.setLocalInferenceActive.mockResolvedValue({
      status: "ready",
      modelId: "eliza-1-0_8b",
    });

    const readiness = await prepareFirstRunVoiceAndTranscription();

    expect(readiness.status).toBe("ready");
    expect(mockClient.setLocalInferenceActive).toHaveBeenCalledWith(
      "eliza-1-0_8b",
    );
    expect(mockClient.startLocalInferenceDownload).not.toHaveBeenCalled();
  });

  it("does not query local-inference when desktop mic capture is unavailable", async () => {
    asrSupport.supported = false;

    const readiness = await prepareFirstRunVoiceAndTranscription();

    expect(readiness).toEqual({
      status: "preparing",
      message: "Preparing desktop microphone capture.",
    });
    expect(mockClient.getLocalInferenceActive).not.toHaveBeenCalled();
    expect(mockClient.getLocalInferenceHub).not.toHaveBeenCalled();
  });
});

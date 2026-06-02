import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configMock = vi.hoisted(() => ({
  loadElizaConfig: vi.fn(),
  isElizaCloudServiceSelectedInConfig: vi.fn(() => false),
}));

vi.mock("../config/config.ts", () => ({
  loadElizaConfig: configMock.loadElizaConfig,
}));

vi.mock("@elizaos/shared", async () => {
  const actual =
    await vi.importActual<typeof import("@elizaos/shared")>("@elizaos/shared");
  return {
    ...actual,
    isElizaCloudServiceSelectedInConfig:
      configMock.isElizaCloudServiceSelectedInConfig,
  };
});

function runtime(): IAgentRuntime {
  return {} as IAgentRuntime;
}

describe("AgentMediaGenerationService video generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.isElizaCloudServiceSelectedInConfig.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies configured video defaultDuration when request duration is absent", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        video: { url: "https://cdn.example/video.mp4" },
        thumbnail: { url: "https://cdn.example/thumb.jpg" },
        duration: 9,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    configMock.loadElizaConfig.mockReturnValue({
      media: {
        video: {
          mode: "own-key",
          provider: "fal",
          defaultDuration: 9,
          fal: {
            apiKey: "fal-key",
            model: "fal-ai/minimax-video",
            baseUrl: "https://fal.test",
          },
        },
      },
    });

    const { AgentMediaGenerationService } = await import(
      "./media-generation.ts"
    );
    const service = new AgentMediaGenerationService(runtime());
    const result = await service.generateMedia({
      mediaType: "video",
      prompt: "glass lighthouse",
      aspectRatio: "16:9",
    });

    expect(result).toEqual({
      mediaType: "video",
      url: "https://cdn.example/video.mp4",
      videoUrl: "https://cdn.example/video.mp4",
      thumbnailUrl: "https://cdn.example/thumb.jpg",
      duration: 9,
      mimeType: "video/mp4",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const requestBody = JSON.parse(init.body as string) as Record<
      string,
      unknown
    >;
    expect(requestBody.duration).toBe(9);
  });

  it("lets explicit request duration override configured video defaultDuration", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        video: { url: "https://cdn.example/video.mp4" },
        duration: 4,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    configMock.loadElizaConfig.mockReturnValue({
      media: {
        video: {
          mode: "own-key",
          provider: "fal",
          defaultDuration: 9,
          fal: {
            apiKey: "fal-key",
            model: "fal-ai/minimax-video",
            baseUrl: "https://fal.test",
          },
        },
      },
    });

    const { AgentMediaGenerationService } = await import(
      "./media-generation.ts"
    );
    const service = new AgentMediaGenerationService(runtime());
    await service.generateMedia({
      mediaType: "video",
      prompt: "short clip",
      duration: 4,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const requestBody = JSON.parse(init.body as string) as Record<
      string,
      unknown
    >;
    expect(requestBody.duration).toBe(4);
  });
});

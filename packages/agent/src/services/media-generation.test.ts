import { type IAgentRuntime, ModelType } from "@elizaos/core";
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

type RuntimeOverrides = Omit<
  Partial<IAgentRuntime>,
  "getModel" | "useModel"
> & {
  getModel?: (modelType: string) => ReturnType<IAgentRuntime["getModel"]>;
  useModel?: (
    modelType: string,
    params: { prompt: string; size?: string; count?: number },
  ) => Promise<Array<{ url: string }>>;
};

function runtime(overrides: RuntimeOverrides = {}): IAgentRuntime {
  return overrides as IAgentRuntime;
}

describe("AgentMediaGenerationService media generation", () => {
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

  it("routes cloud image generation through the registered image model", async () => {
    const imageModel = async () => ({});
    const useModel = vi.fn(async () => [
      { url: "https://cdn.example/generated.png" },
    ]);
    const getModel = vi.fn((modelType: string) =>
      modelType === ModelType.IMAGE ? imageModel : undefined,
    );
    configMock.isElizaCloudServiceSelectedInConfig.mockReturnValue(true);
    configMock.loadElizaConfig.mockReturnValue({
      cloud: {
        apiKey: "eliza_cloud_key",
        baseUrl: "https://api.elizacloud.ai/api/v1",
      },
      media: {
        image: {
          mode: "cloud",
        },
      },
    });

    const { AgentMediaGenerationService } = await import(
      "./media-generation.ts"
    );
    const service = new AgentMediaGenerationService(
      runtime({
        getModel,
        useModel,
      }),
    );

    await expect(
      service.generateMedia({
        mediaType: "image",
        prompt: "a cat in a little space helmet",
        size: "1024x1024",
      }),
    ).resolves.toEqual({
      mediaType: "image",
      url: "https://cdn.example/generated.png",
      imageUrl: "https://cdn.example/generated.png",
      mimeType: "image/png",
    });

    expect(getModel).toHaveBeenCalledWith(ModelType.IMAGE);
    expect(useModel).toHaveBeenCalledWith(ModelType.IMAGE, {
      prompt: "a cat in a little space helmet",
      size: "1024x1024",
      count: 1,
    });
  });

  it("uses configured own-key image providers instead of the image model", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        images: [{ url: "https://cdn.example/fal-image.png" }],
      }),
    );
    const useModel = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    configMock.isElizaCloudServiceSelectedInConfig.mockReturnValue(true);
    configMock.loadElizaConfig.mockReturnValue({
      media: {
        image: {
          mode: "own-key",
          provider: "fal",
          fal: {
            apiKey: "fal-key",
            model: "fal-ai/flux-pro",
            baseUrl: "https://fal.test",
          },
        },
      },
    });

    const { AgentMediaGenerationService } = await import(
      "./media-generation.ts"
    );
    const service = new AgentMediaGenerationService(
      runtime({
        useModel,
      }),
    );

    await expect(
      service.generateMedia({
        mediaType: "image",
        prompt: "a glass lighthouse",
        size: "square_hd",
      }),
    ).resolves.toEqual({
      mediaType: "image",
      url: "https://cdn.example/fal-image.png",
      imageUrl: "https://cdn.example/fal-image.png",
      imageBase64: undefined,
      revisedPrompt: undefined,
      mimeType: "image/png",
    });

    expect(useModel).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://fal.test/fal-ai/flux-pro",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Key fal-key",
        }),
      }),
    );
  });

  it("reports cloud image generation unavailable when no image model is registered", async () => {
    configMock.isElizaCloudServiceSelectedInConfig.mockReturnValue(true);
    configMock.loadElizaConfig.mockReturnValue({
      media: {
        image: {
          mode: "cloud",
        },
      },
    });

    const { AgentMediaGenerationService } = await import(
      "./media-generation.ts"
    );
    const service = new AgentMediaGenerationService(
      runtime({
        getModel: vi.fn(() => undefined),
      }),
    );

    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(false);
    await expect(
      service.generateMedia({
        mediaType: "image",
        prompt: "a cat",
      }),
    ).rejects.toThrow(/requires Eliza Cloud or a direct image provider/);
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

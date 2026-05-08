import {
  IMediaGenerationService,
  type IAgentRuntime,
  type MediaGenerationRequest,
  type MediaGenerationResponse,
  ServiceType,
} from "@elizaos/core";
import { isElizaCloudServiceSelectedInConfig } from "@elizaos/shared";
import { loadElizaConfig } from "../config/config.js";
import {
  createAudioProvider,
  createImageProvider,
  createVideoProvider,
  type MediaProviderFactoryOptions,
} from "../providers/media-provider.js";

function getMediaProviderOptions(): MediaProviderFactoryOptions {
  const config = loadElizaConfig();
  const cloudMediaSelected = isElizaCloudServiceSelectedInConfig(
    config as Record<string, unknown>,
    "media",
  );
  return {
    elizaCloudBaseUrl: config.cloud?.baseUrl ?? "https://elizacloud.ai/api/v1",
    elizaCloudApiKey: config.cloud?.apiKey,
    cloudMediaDisabled: !cloudMediaSelected,
  };
}

export class AgentMediaGenerationService extends IMediaGenerationService {
  static override readonly serviceType = ServiceType.MEDIA_GENERATION;

  readonly capabilityDescription =
    "Generates image, video, and audio through configured local media providers.";

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<AgentMediaGenerationService> {
    return new AgentMediaGenerationService(runtime);
  }

  async stop(): Promise<void> {}

  async generateMedia(
    request: MediaGenerationRequest,
  ): Promise<MediaGenerationResponse> {
    const config = loadElizaConfig();
    const providerOptions = getMediaProviderOptions();

    if (request.mediaType === "image") {
      const result = await createImageProvider(
        config.media?.image,
        providerOptions,
      ).generate({
        prompt: request.prompt,
        size: request.size,
        quality: request.quality,
        style: request.style,
        negativePrompt: request.negativePrompt,
        seed: request.seed,
      });

      if (!result.success || !result.data) {
        throw new Error(result.error ?? "Image generation failed");
      }

      return {
        mediaType: "image",
        url: result.data.imageUrl,
        imageUrl: result.data.imageUrl,
        imageBase64: result.data.imageBase64,
        revisedPrompt: result.data.revisedPrompt,
        mimeType: "image/png",
      };
    }

    if (request.mediaType === "video") {
      const result = await createVideoProvider(
        config.media?.video,
        providerOptions,
      ).generate({
        prompt: request.prompt,
        duration: request.duration,
        aspectRatio: request.aspectRatio,
        imageUrl: request.imageUrl,
      });

      if (!result.success || !result.data) {
        throw new Error(result.error ?? "Video generation failed");
      }

      return {
        mediaType: "video",
        url: result.data.videoUrl,
        videoUrl: result.data.videoUrl,
        thumbnailUrl: result.data.thumbnailUrl,
        duration: result.data.duration,
        mimeType: "video/mp4",
      };
    }

    const result = await createAudioProvider(
      config.media?.audio,
      providerOptions,
    ).generate({
      prompt: request.prompt,
      duration: request.duration,
      instrumental: request.instrumental,
      genre: request.genre,
    });

    if (!result.success || !result.data) {
      throw new Error(result.error ?? "Audio generation failed");
    }

    return {
      mediaType: "audio",
      audioKind: request.audioKind,
      url: result.data.audioUrl,
      audioUrl: result.data.audioUrl,
      title: result.data.title,
      duration: result.data.duration,
      mimeType: "audio/mpeg",
    };
  }
}

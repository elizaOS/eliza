/**
 * Fills `ServiceType.MEDIA_GENERATION` for the agent runtime. Routes image,
 * video, and audio (music / TTS / SFX) generation requests down one of two
 * paths per the media config: cloud-selected model handlers invoked through
 * `runtime.useModel` (`ModelType.IMAGE`/`VIDEO`/`AUDIO`/`TEXT_TO_SPEECH`), or
 * an own-key direct provider built by the media-provider factories. Also
 * answers `canGenerateMedia` so callers can probe availability before asking.
 */

import { Buffer } from "node:buffer";
import {
  type IAgentRuntime,
  IMediaGenerationService,
  type MediaGenerationRequest,
  type MediaGenerationResponse,
  ModelType,
  ServiceType,
} from "@elizaos/core";
import { isElizaCloudServiceSelectedInConfig } from "@elizaos/shared";
import { loadElizaConfig } from "../config/config.ts";
import type {
  AudioGenConfig,
  ImageConfig,
  VideoConfig,
} from "../config/types.eliza.ts";
import {
  createAudioProvider,
  createImageProvider,
  createVideoProvider,
  type MediaProviderFactoryOptions,
} from "../providers/media-provider.ts";

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

function imageConfigUsesCloud(
  config: ImageConfig | undefined,
  options: MediaProviderFactoryOptions,
): boolean {
  const mode =
    config?.mode ?? (options.cloudMediaDisabled ? "own-key" : "cloud");
  return mode === "cloud" && !options.cloudMediaDisabled;
}

function videoConfigUsesCloud(
  config: VideoConfig | undefined,
  options: MediaProviderFactoryOptions,
): boolean {
  const mode =
    config?.mode ?? (options.cloudMediaDisabled ? "own-key" : "cloud");
  return mode === "cloud" && !options.cloudMediaDisabled;
}

function audioConfigUsesCloud(
  config: AudioGenConfig | undefined,
  options: MediaProviderFactoryOptions,
): boolean {
  const mode =
    config?.mode ?? (options.cloudMediaDisabled ? "own-key" : "cloud");
  return mode === "cloud" && !options.cloudMediaDisabled;
}

function hasGenerationModel(
  runtime: IAgentRuntime,
  modelType: string,
): boolean {
  return typeof runtime.getModel(modelType) === "function";
}

function hasImageGenerationModel(runtime: IAgentRuntime): boolean {
  return hasGenerationModel(runtime, ModelType.IMAGE);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesToAudioDataUrl(value: Buffer | ArrayBuffer | Uint8Array): string {
  const bytes =
    value instanceof ArrayBuffer
      ? Buffer.from(value)
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return `data:audio/mpeg;base64,${bytes.toString("base64")}`;
}

async function generateImageWithModel(
  runtime: IAgentRuntime,
  request: MediaGenerationRequest,
): Promise<MediaGenerationResponse> {
  if (!hasImageGenerationModel(runtime)) {
    throw new Error(
      "Image generation requires Eliza Cloud or a direct image provider. " +
        "Enable @elizaos/plugin-elizacloud with ELIZAOS_CLOUD_API_KEY, or configure an own-key image provider.",
    );
  }

  const imageResponse = await runtime.useModel(ModelType.IMAGE, {
    prompt: request.prompt,
    size: request.size,
    count: 1,
  });
  const firstImage = Array.isArray(imageResponse)
    ? imageResponse[0]
    : undefined;
  const imageUrl = firstImage?.url;

  if (!imageUrl) {
    throw new Error(
      "Image generation requires Eliza Cloud or a direct image provider, but no image URL was returned.",
    );
  }

  return {
    mediaType: "image",
    url: imageUrl,
    imageUrl,
    mimeType: "image/png",
  };
}

async function generateVideoWithModel(
  runtime: IAgentRuntime,
  request: MediaGenerationRequest,
  config: VideoConfig | undefined,
): Promise<MediaGenerationResponse> {
  if (!hasGenerationModel(runtime, ModelType.VIDEO)) {
    throw new Error(
      "Video generation requires Eliza Cloud or a direct video provider. " +
        "Enable @elizaos/plugin-elizacloud with ELIZAOS_CLOUD_API_KEY, or configure an own-key video provider.",
    );
  }

  const videoResponse = await runtime.useModel(ModelType.VIDEO, {
    prompt: request.prompt,
    duration: request.duration ?? config?.defaultDuration,
    durationSeconds: request.duration ?? config?.defaultDuration,
    aspectRatio: request.aspectRatio,
    imageUrl: request.imageUrl,
    referenceUrl: request.imageUrl,
  });

  if (!isRecord(videoResponse)) {
    throw new Error(
      "Video generation requires Eliza Cloud or a direct video provider, but no video URL was returned.",
    );
  }

  const videoUrl =
    stringValue(videoResponse.videoUrl) ?? stringValue(videoResponse.url);
  if (!videoUrl) {
    throw new Error(
      "Video generation requires Eliza Cloud or a direct video provider, but no video URL was returned.",
    );
  }

  return {
    mediaType: "video",
    url: videoUrl,
    videoUrl,
    thumbnailUrl: stringValue(videoResponse.thumbnailUrl),
    duration: numberValue(videoResponse.duration),
    mimeType: stringValue(videoResponse.mimeType) ?? "video/mp4",
  };
}

async function generateAudioWithModel(
  runtime: IAgentRuntime,
  request: MediaGenerationRequest,
): Promise<MediaGenerationResponse> {
  if (request.audioKind === "tts") {
    if (!hasGenerationModel(runtime, ModelType.TEXT_TO_SPEECH)) {
      throw new Error(
        "Speech audio generation requires Eliza Cloud TTS or a direct audio provider.",
      );
    }

    const speech = await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
      text: request.prompt,
      voice: request.voice,
    });
    const audioUrl = bytesToAudioDataUrl(speech);
    return {
      mediaType: "audio",
      audioKind: "tts",
      url: audioUrl,
      audioUrl,
      mimeType: "audio/mpeg",
    };
  }

  if (request.audioKind === "sfx") {
    throw new Error(
      "Cloud sound-effect generation is not available. Configure a direct ElevenLabs or FAL audio provider.",
    );
  }

  if (!hasGenerationModel(runtime, ModelType.AUDIO)) {
    throw new Error(
      "Music generation requires Eliza Cloud or a direct audio provider. " +
        "Enable @elizaos/plugin-elizacloud with ELIZAOS_CLOUD_API_KEY, or configure an own-key audio provider.",
    );
  }

  const audioResponse = await runtime.useModel(ModelType.AUDIO, {
    prompt: request.prompt,
    audioKind: request.audioKind ?? "music",
    duration: request.duration,
    durationSeconds: request.duration,
    instrumental: request.instrumental,
    genre: request.genre,
    seed: request.seed,
  });

  if (!isRecord(audioResponse)) {
    throw new Error(
      "Music generation requires Eliza Cloud or a direct audio provider, but no audio URL was returned.",
    );
  }

  const audioUrl =
    stringValue(audioResponse.audioUrl) ?? stringValue(audioResponse.url);
  if (!audioUrl) {
    throw new Error(
      "Music generation requires Eliza Cloud or a direct audio provider, but no audio URL was returned.",
    );
  }

  return {
    mediaType: "audio",
    audioKind: request.audioKind,
    url: audioUrl,
    audioUrl,
    title: stringValue(audioResponse.title),
    duration: numberValue(audioResponse.duration),
    mimeType: stringValue(audioResponse.mimeType) ?? "audio/mpeg",
  };
}

export class AgentMediaGenerationService extends IMediaGenerationService {
  static override readonly serviceType = ServiceType.MEDIA_GENERATION;

  override readonly capabilityDescription: string =
    "Generates image, video, and audio through configured media providers or a registered image model.";

  static async start(
    runtime: IAgentRuntime,
  ): Promise<AgentMediaGenerationService> {
    return new AgentMediaGenerationService(runtime);
  }

  async stop(): Promise<void> {}

  canGenerateMedia(
    request: Pick<MediaGenerationRequest, "mediaType" | "audioKind">,
  ): boolean {
    const config = loadElizaConfig();
    const providerOptions = getMediaProviderOptions();
    try {
      if (request.mediaType === "image") {
        if (imageConfigUsesCloud(config.media?.image, providerOptions)) {
          return hasImageGenerationModel(this.runtime);
        }
        createImageProvider(config.media?.image, providerOptions);
        return true;
      }
      if (request.mediaType === "video") {
        if (videoConfigUsesCloud(config.media?.video, providerOptions)) {
          return hasGenerationModel(this.runtime, ModelType.VIDEO);
        }
        createVideoProvider(config.media?.video, providerOptions);
        return true;
      }
      if (audioConfigUsesCloud(config.media?.audio, providerOptions)) {
        if (request.audioKind === "sfx") return false;
        return hasGenerationModel(
          this.runtime,
          request.audioKind === "tts"
            ? ModelType.TEXT_TO_SPEECH
            : ModelType.AUDIO,
        );
      }
      createAudioProvider(config.media?.audio, providerOptions);
      return true;
    } catch {
      return false;
    }
  }

  async generateMedia(
    request: MediaGenerationRequest,
  ): Promise<MediaGenerationResponse> {
    const config = loadElizaConfig();
    const providerOptions = getMediaProviderOptions();

    if (request.mediaType === "image") {
      if (imageConfigUsesCloud(config.media?.image, providerOptions)) {
        return generateImageWithModel(this.runtime, request);
      }

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
      if (videoConfigUsesCloud(config.media?.video, providerOptions)) {
        return generateVideoWithModel(
          this.runtime,
          request,
          config.media?.video,
        );
      }

      const result = await createVideoProvider(
        config.media?.video,
        providerOptions,
      ).generate({
        prompt: request.prompt,
        duration: request.duration ?? config.media?.video?.defaultDuration,
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

    if (audioConfigUsesCloud(config.media?.audio, providerOptions)) {
      return generateAudioWithModel(this.runtime, request);
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

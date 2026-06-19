import {
  type IAgentRuntime,
  IMediaGenerationService,
  type ImageGenerationResult,
  logger,
  type MediaGenerationRequest,
  type MediaGenerationResponse,
  ModelType,
  ServiceType,
} from "@elizaos/core";

type ImageResultLike =
  | string
  | (Partial<ImageGenerationResult> & {
      imageUrl?: string;
      imageBase64?: string;
      mimeType?: string;
      revisedPrompt?: string;
    });

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

function imageMimeTypeFromUrl(url: string): string | undefined {
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+)/.exec(url);
    return match?.[1];
  }

  try {
    const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
    return extension ? IMAGE_MIME_BY_EXTENSION[extension] : undefined;
  } catch {
    return undefined;
  }
}

function normalizeImageResult(result: ImageResultLike | undefined): MediaGenerationResponse | null {
  if (!result) {
    return null;
  }

  if (typeof result === "string") {
    return {
      mediaType: "image",
      url: result,
      imageUrl: result,
      mimeType: imageMimeTypeFromUrl(result),
    };
  }

  const url =
    typeof result.url === "string"
      ? result.url
      : typeof result.imageUrl === "string"
        ? result.imageUrl
        : undefined;

  if (url) {
    return {
      mediaType: "image",
      url,
      imageUrl: url,
      mimeType: result.mimeType ?? imageMimeTypeFromUrl(url),
      revisedPrompt: result.revisedPrompt,
    };
  }

  if (typeof result.imageBase64 === "string" && result.imageBase64.length > 0) {
    const mimeType = result.mimeType ?? "image/png";
    const imageUrl = result.imageBase64.startsWith("data:")
      ? result.imageBase64
      : `data:${mimeType};base64,${result.imageBase64}`;

    return {
      mediaType: "image",
      url: imageUrl,
      imageUrl,
      imageBase64: result.imageBase64,
      mimeType,
      revisedPrompt: result.revisedPrompt,
    };
  }

  return null;
}

export class CloudMediaGenerationService extends IMediaGenerationService {
  static override readonly serviceType = ServiceType.MEDIA_GENERATION;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<CloudMediaGenerationService> {
    return new CloudMediaGenerationService(runtime);
  }

  async stop(): Promise<void> {}

  async generateMedia(request: MediaGenerationRequest): Promise<MediaGenerationResponse> {
    if (request.mediaType !== "image") {
      throw new Error(`Cloud media generation currently supports image output only.`);
    }

    const prompt = request.prompt.trim();
    if (!prompt) {
      throw new Error("Media generation prompt is required.");
    }

    const imageResponse = await this.runtime.useModel(ModelType.IMAGE, {
      prompt,
      ...(request.size ? { size: request.size } : {}),
    });

    const imageResults = Array.isArray(imageResponse)
      ? (imageResponse as ImageResultLike[])
      : typeof imageResponse === "string"
        ? [imageResponse]
        : [];
    const media = normalizeImageResult(imageResults[0]);

    if (!media?.imageUrl && !media?.url) {
      logger.error(
        {
          src: "cloud:media_generation",
          mediaType: request.mediaType,
          prompt,
        },
        "Media generation failed - no valid image result received",
      );
      throw new Error("Image model returned no media result.");
    }

    return {
      ...media,
      mediaType: "image",
      revisedPrompt: media.revisedPrompt,
      provider: "runtime-model",
    };
  }
}

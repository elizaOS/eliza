/** Stateless own-key media adapters. The host supplies configuration and cancellation. */
import { type ImageConfig, type VideoConfig, type VisionConfig } from "@elizaos/contracts";
import {type ImageGenerationOptions, type ImageGenerationProvider, type MediaImageGenerationResult as ImageGenerationResult, type VideoGenerationOptions, type VideoGenerationProvider, type VideoGenerationResult, type VisionAnalysisOptions, type VisionAnalysisProvider, type VisionAnalysisResult, type MediaProviderResult, fetchMediaProviderResponse as fetchWithTimeout, withMediaProviderErrorBoundary as withProviderErrorBoundary, resolveVisionImageInput, isMediaProviderResult} from "@elizaos/host/protocol";
export class OpenAIImageProvider implements ImageGenerationProvider {
  name = "openai";
  private apiKey: string;
  private model: string;
  private quality: "standard" | "hd";
  private style: "natural" | "vivid";

  constructor(config: NonNullable<ImageConfig["openai"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "dall-e-3";
    this.quality = config.quality ?? "standard";
    this.style = config.style ?? "vivid";
  }

  async generate(
    options: ImageGenerationOptions,
  ): Promise<MediaProviderResult<ImageGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(
        "https://api.openai.com/v1/images/generations",
        {
          signal: options.signal,

          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            prompt: options.prompt,
            n: 1,
            size: options.size ?? "1024x1024",
            quality: options.quality ?? this.quality,
            style: options.style ?? this.style,
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `OpenAI error: ${text}` };
      }

      const data = (await response.json()) as {
        data?: Array<{ url?: string; revised_prompt?: string }>;
      };
      const image = data.data?.[0];
      if (!image?.url) {
        return { success: false, error: "No image returned from OpenAI" };
      }

      return {
        success: true,
        data: {
          imageUrl: image.url,
          revisedPrompt: image.revised_prompt,
        },
      };
    });
  }
}

export class OpenAIVideoProvider implements VideoGenerationProvider {
  name = "openai";
  private apiKey: string;
  private model: string;

  constructor(config: NonNullable<VideoConfig["openai"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "sora-1.0-turbo";
  }

  async generate(
    options: VideoGenerationOptions,
  ): Promise<MediaProviderResult<VideoGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      // OpenAI Sora API (video generation)
      const response = await fetchWithTimeout(
        "https://api.openai.com/v1/videos/generations",
        {
          signal: options.signal,

          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            prompt: options.prompt,
            n: 1,
            duration: options.duration ?? 5,
            aspect_ratio: options.aspectRatio ?? "16:9",
            ...(options.imageUrl ? { image: options.imageUrl } : {}),
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `OpenAI Sora error: ${text}` };
      }

      const data = (await response.json()) as {
        data?: Array<{ url?: string; duration?: number }>;
      };
      const video = data.data?.[0];
      if (!video?.url) {
        return { success: false, error: "No video returned from OpenAI Sora" };
      }

      return {
        success: true,
        data: {
          videoUrl: video.url,
          duration: video.duration,
        },
      };
    });
  }
}

export class OpenAIVisionProvider implements VisionAnalysisProvider {
  name = "openai";
  private apiKey: string;
  private model: string;
  private maxTokens?: number;

  constructor(config: NonNullable<VisionConfig["openai"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    // Mirrors plugin-openai's IMAGE_DESCRIPTION default (utils/config.ts).
    this.model = config.model ?? "gpt-5-mini";
    this.maxTokens = config.maxTokens;
  }

  async analyze(
    options: VisionAnalysisOptions,
  ): Promise<MediaProviderResult<VisionAnalysisResult>> {
    const imageInput = resolveVisionImageInput(this.name, options);
    if (isMediaProviderResult(imageInput)) return imageInput;
    const imageContent =
      imageInput.type === "base64"
        ? {
            type: "image_url" as const,
            image_url: { url: `data:image/jpeg;base64,${imageInput.value}` },
          }
        : {
            type: "image_url" as const,
            image_url: { url: imageInput.value },
          };

    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(
        "https://api.openai.com/v1/chat/completions",
        {
          signal: options.signal,

          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            ...((options.maxTokens ?? this.maxTokens) !== undefined
              ? { max_tokens: options.maxTokens ?? this.maxTokens }
              : {}),
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: options.prompt ?? "Describe this image in detail.",
                  },
                  imageContent,
                ],
              },
            ],
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `OpenAI error: ${text}` };
      }

      const data = (await response.json()) as {
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string };
        }>;
      };
      if (data.choices?.[0]?.finish_reason === "length") {
        return {
          success: false,
          error:
            "OpenAI returned an incomplete vision description after reaching an output limit",
        };
      }
      const description = data.choices?.[0]?.message?.content;
      if (!description) {
        return {
          success: false,
          error: "No description returned from OpenAI",
        };
      }

      return {
        success: true,
        data: { description },
      };
    });
  }
}

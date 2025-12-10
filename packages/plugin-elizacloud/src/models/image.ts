import type { IAgentRuntime, ImageDescriptionParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import {
  getSetting,
  getBaseURL,
  getAuthHeader,
  getImageDescriptionModel,
  getImageGenerationModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { parseImageDescriptionResponse } from "../utils/helpers";
import type { ImageDescriptionResult } from "../types";

/**
 * IMAGE model handler - generates images from text prompts
 * Uses ElizaOS Cloud's custom /generate-image endpoint (not OpenAI-compatible)
 */
export async function handleImageGeneration(
  runtime: IAgentRuntime,
  params: {
    prompt: string;
    n?: number;
    size?: string;
  },
): Promise<{ url: string }[]> {
  const numImages = params.n || 1;
  const size = params.size || "1024x1024";
  const prompt = params.prompt;
  const modelName = getImageGenerationModel(runtime);
  logger.log(`[ELIZAOS_CLOUD] Using IMAGE model: ${modelName}`);

  const baseURL = getBaseURL(runtime);

  // Convert size to aspect ratio for ElizaOS Cloud API
  const aspectRatioMap: Record<string, string> = {
    "1024x1024": "1:1",
    "1792x1024": "16:9",
    "1024x1792": "9:16",
  };
  const aspectRatio = aspectRatioMap[size] || "1:1";

  try {
    // ElizaOS Cloud uses /generate-image endpoint, not /images/generations
    const response = await fetch(`${baseURL}/generate-image`, {
      method: "POST",
      headers: {
        ...getAuthHeader(runtime),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: prompt,
        numImages: numImages,
        aspectRatio: aspectRatio,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to generate image: ${response.status} ${errorText}`,
      );
    }

    const data = await response.json();
    const typedData = data as {
      images: Array<{ url?: string; image: string }>;
      numImages: number;
    };

    // Map response to expected format
    return typedData.images.map((img) => ({
      url: img.url || img.image,
    }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[ELIZAOS_CLOUD] Image generation error: ${message}`);
    throw error;
  }
}

/**
 * IMAGE_DESCRIPTION model handler - analyzes images and provides descriptions
 */
export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string,
): Promise<ImageDescriptionResult | string> {
  let imageUrl: string;
  let promptText: string | undefined;
  const modelName = getImageDescriptionModel(runtime);
  logger.log(`[ELIZAOS_CLOUD] Using IMAGE_DESCRIPTION model: ${modelName}`);
  const maxTokens = Number.parseInt(
    getSetting(runtime, "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS", "8192") ||
      "8192",
    10,
  );

  if (typeof params === "string") {
    imageUrl = params;
    promptText =
      "Please analyze this image and provide a title and detailed description.";
  } else {
    imageUrl = params.imageUrl;
    promptText =
      params.prompt ||
      "Please analyze this image and provide a title and detailed description.";
  }

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: promptText },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ];

  const baseURL = getBaseURL(runtime);

  try {
    const requestBody: Record<string, unknown> = {
      model: modelName,
      messages: messages,
      max_tokens: maxTokens,
    };

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeader(runtime),
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`ElizaOS Cloud API error: ${response.status}`);
    }

    const result: unknown = await response.json();

    type OpenAIResponseType = {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const typedResult = result as OpenAIResponseType;
    const content = typedResult.choices?.[0]?.message?.content;

    if (typedResult.usage) {
      emitModelUsageEvent(
        runtime,
        ModelType.IMAGE_DESCRIPTION,
        typeof params === "string" ? params : params.prompt || "",
        {
          inputTokens: typedResult.usage.prompt_tokens,
          outputTokens: typedResult.usage.completion_tokens,
          totalTokens: typedResult.usage.total_tokens,
        },
      );
    }

    if (!content) {
      return {
        title: "Failed to analyze image",
        description: "No response from API",
      };
    }

    // Check if a custom prompt was provided (not the default prompt)
    const isCustomPrompt =
      typeof params === "object" &&
      params.prompt &&
      params.prompt !==
        "Please analyze this image and provide a title and detailed description.";

    // If custom prompt is used, return the raw content
    if (isCustomPrompt) {
      return content;
    }

    // Otherwise, maintain backwards compatibility with object return
    const processedResult = parseImageDescriptionResponse(content);
    return processedResult;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error analyzing image: ${message}`);
    return {
      title: "Failed to analyze image",
      description: `Error: ${message}`,
    };
  }
}

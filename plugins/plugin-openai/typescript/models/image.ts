/**
 * Image model handlers
 *
 * Provides image generation and description functionality.
 */

import type {
  IAgentRuntime,
  ImageDescriptionParams,
  ImageGenerationParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import type {
  ImageDescriptionResult,
  ImageGenerationResult,
  ImageQuality,
  ImageSize,
  ImageStyle,
  OpenAIChatCompletionResponse,
  OpenAIImageGenerationResponse,
} from "../types";
import {
  getAuthHeader,
  getBaseURL,
  getImageDescriptionMaxTokens,
  getImageDescriptionModel,
  getImageModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

/**
 * Extended image generation params that may include OpenAI-specific options
 */
interface ExtendedImageGenerationParams extends ImageGenerationParams {
  quality?: ImageQuality;
  style?: ImageStyle;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default prompt for image description
 */
const DEFAULT_IMAGE_DESCRIPTION_PROMPT =
  "Please analyze this image and provide a title and detailed description.";

// ============================================================================
// Image Generation
// ============================================================================

/**
 * Generates images using OpenAI's image generation API (DALL-E).
 *
 * @param runtime - The agent runtime
 * @param params - Image generation parameters
 * @returns Array of generated image URLs
 * @throws Error if generation fails
 */
export async function handleImageGeneration(
  runtime: IAgentRuntime,
  params: ImageGenerationParams
): Promise<ImageGenerationResult[]> {
  const modelName = getImageModel(runtime);
  const count = params.count ?? 1;
  const size: ImageSize = (params.size as ImageSize) ?? "1024x1024";

  // Cast to extended type for OpenAI-specific params
  const extendedParams = params as ExtendedImageGenerationParams;

  logger.debug(`[OpenAI] Using IMAGE model: ${modelName}`);

  // Validate parameters
  if (!params.prompt || params.prompt.trim().length === 0) {
    throw new Error("IMAGE generation requires a non-empty prompt");
  }

  if (count < 1 || count > 10) {
    throw new Error("IMAGE count must be between 1 and 10");
  }

  const baseURL = getBaseURL(runtime);

  const requestBody: Record<string, string | number> = {
    model: modelName,
    prompt: params.prompt,
    n: count,
    size,
  };

  // Add optional quality and style for DALL-E 3
  if (extendedParams.quality) {
    requestBody.quality = extendedParams.quality;
  }
  if (extendedParams.style) {
    requestBody.style = extendedParams.style;
  }

  const response = await fetch(`${baseURL}/images/generations`, {
    method: "POST",
    headers: {
      ...getAuthHeader(runtime),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `OpenAI image generation failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const data = (await response.json()) as OpenAIImageGenerationResponse;

  if (!data.data || data.data.length === 0) {
    throw new Error("OpenAI API returned no images");
  }

  return data.data.map((item) => ({
    url: item.url,
    revisedPrompt: item.revised_prompt,
  }));
}

// ============================================================================
// Image Description
// ============================================================================

/**
 * Parses a title from the model's response text.
 */
function parseTitleFromResponse(content: string): string {
  const titleMatch = content.match(/title[:\s]+(.+?)(?:\n|$)/i);
  return (titleMatch && titleMatch[1] && titleMatch[1].trim()) ?? "Image Analysis";
}

/**
 * Parses a description from the model's response text.
 */
function parseDescriptionFromResponse(content: string): string {
  return content.replace(/title[:\s]+(.+?)(?:\n|$)/i, "").trim();
}

/**
 * Describes/analyzes an image using OpenAI's vision capabilities.
 *
 * @param runtime - The agent runtime
 * @param params - Image URL or description parameters
 * @returns Title and description of the image
 * @throws Error if analysis fails
 */
export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string
): Promise<ImageDescriptionResult> {
  const modelName = getImageDescriptionModel(runtime);
  const maxTokens = getImageDescriptionMaxTokens(runtime);

  logger.debug(`[OpenAI] Using IMAGE_DESCRIPTION model: ${modelName}`);

  // Normalize parameters
  let imageUrl: string;
  let promptText: string;

  if (typeof params === "string") {
    imageUrl = params;
    promptText = DEFAULT_IMAGE_DESCRIPTION_PROMPT;
  } else {
    imageUrl = params.imageUrl;
    promptText = params.prompt ?? DEFAULT_IMAGE_DESCRIPTION_PROMPT;
  }

  // Validate URL
  if (!imageUrl || imageUrl.trim().length === 0) {
    throw new Error("IMAGE_DESCRIPTION requires a valid image URL");
  }

  const baseURL = getBaseURL(runtime);

  const requestBody = {
    model: modelName,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptText },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: maxTokens,
  };

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      ...getAuthHeader(runtime),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `OpenAI image description failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const data = (await response.json()) as OpenAIChatCompletionResponse;

  // Emit usage event
  if (data.usage) {
    emitModelUsageEvent(
      runtime,
      ModelType.IMAGE_DESCRIPTION,
      typeof params === "string" ? params : params.prompt ?? "",
      {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      }
    );
  }

  // Extract content from response
  const firstChoice = data.choices && data.choices[0];
  const content = firstChoice && firstChoice.message && firstChoice.message.content;

  if (!content) {
    throw new Error("OpenAI API returned empty image description");
  }

  return {
    title: parseTitleFromResponse(content),
    description: parseDescriptionFromResponse(content),
  };
}

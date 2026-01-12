import type { IAgentRuntime, ImageDescriptionParams, ImageGenerationParams } from "@elizaos/core";
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

interface ExtendedImageGenerationParams extends ImageGenerationParams {
  quality?: ImageQuality;
  style?: ImageStyle;
}

const DEFAULT_IMAGE_DESCRIPTION_PROMPT =
  "Please analyze this image and provide a title and detailed description.";

export async function handleImageGeneration(
  runtime: IAgentRuntime,
  params: ImageGenerationParams
): Promise<ImageGenerationResult[]> {
  const modelName = getImageModel(runtime);
  const count = params.count ?? 1;
  const size: ImageSize = (params.size as ImageSize) ?? "1024x1024";
  const extendedParams = params as ExtendedImageGenerationParams;

  logger.debug(`[OpenAI] Using IMAGE model: ${modelName}`);

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

function parseTitleFromResponse(content: string): string {
  const titleMatch = content.match(/title[:\s]+(.+?)(?:\n|$)/i);
  return titleMatch?.[1]?.trim() ?? "Image Analysis";
}

function parseDescriptionFromResponse(content: string): string {
  return content.replace(/title[:\s]+(.+?)(?:\n|$)/i, "").trim();
}

export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string
): Promise<ImageDescriptionResult> {
  const modelName = getImageDescriptionModel(runtime);
  const maxTokens = getImageDescriptionMaxTokens(runtime);

  logger.debug(`[OpenAI] Using IMAGE_DESCRIPTION model: ${modelName}`);

  let imageUrl: string;
  let promptText: string;

  if (typeof params === "string") {
    imageUrl = params;
    promptText = DEFAULT_IMAGE_DESCRIPTION_PROMPT;
  } else {
    imageUrl = params.imageUrl;
    promptText = params.prompt ?? DEFAULT_IMAGE_DESCRIPTION_PROMPT;
  }

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

  if (data.usage) {
    emitModelUsageEvent(
      runtime,
      ModelType.IMAGE_DESCRIPTION,
      typeof params === "string" ? params : (params.prompt ?? ""),
      {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      }
    );
  }

  const firstChoice = data.choices?.[0];
  const content = firstChoice?.message?.content;

  if (!content) {
    throw new Error("OpenAI API returned empty image description");
  }

  return {
    title: parseTitleFromResponse(content),
    description: parseDescriptionFromResponse(content),
  };
}

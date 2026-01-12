import type {
  IAgentRuntime,
  ImageDescriptionParams,
  ImageGenerationParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import {
  getAuthHeader,
  getBaseURL,
  getImageDescriptionModel,
  getImageGenerationModel,
  getSetting,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { parseImageDescriptionResponse } from "../utils/helpers";

export async function handleImageGeneration(
  runtime: IAgentRuntime,
  params: ImageGenerationParams,
): Promise<{ url: string }[]> {
  const numImages = params.count || 1;
  const size = params.size || "1024x1024";
  const prompt = params.prompt;
  const modelName = getImageGenerationModel(runtime);
  logger.log(`[ELIZAOS_CLOUD] Using IMAGE model: ${modelName}`);

  const baseURL = getBaseURL(runtime);

  const aspectRatioMap: Record<string, string> = {
    "1024x1024": "1:1",
    "1792x1024": "16:9",
    "1024x1792": "9:16",
  };
  const aspectRatio = aspectRatioMap[size] || "1:1";

  try {
    const requestUrl = `${baseURL}/generate-image`;
    const requestBody = {
      prompt: prompt,
      numImages: numImages,
      aspectRatio: aspectRatio,
      model: modelName,
    };

    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        ...getAuthHeader(runtime),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
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

    const result = typedData.images.map((img) => ({
      url: img.url || img.image,
    }));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[ELIZAOS_CLOUD] Image generation error: ${message}`);
    throw error;
  }
}

export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string,
): Promise<{ title: string; description: string }> {
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

    const typedResult = (await response.json()) as OpenAIResponseType;
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

    return parseImageDescriptionResponse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error analyzing image: ${message}`);
    return {
      title: "Failed to analyze image",
      description: `Error: ${message}`,
    };
  }
}

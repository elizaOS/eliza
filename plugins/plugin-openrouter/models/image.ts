/**
 * The `IMAGE_DESCRIPTION` and `IMAGE` (generation) model handlers, both routed
 * through the AI SDK `generateText` against the OpenRouter chat model. Description
 * sends the image URL as a multimodal user message and parses the model's
 * Title/Description text; generation returns the model's text response as the
 * image URL. Both emit a `MODEL_USED` event from the response usage.
 */
import type {
  IAgentRuntime,
  ImageDescriptionParams,
  ImageDescriptionResult,
  ImageGenerationParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText, type LanguageModel } from "ai";

import { createOpenRouterProvider } from "../providers";
import { getImageGenerationModel, getImageModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

const DEFAULT_IMAGE_DESCRIPTION_PROMPT =
  "Analyze this image and respond with:\nTitle: <short title>\nDescription: <detailed description>";

function parseTitle(content: string): string {
  const titleMatch = content.match(/title[:\s]+(.+?)(?:\n|$)/i);
  if (titleMatch?.[1]) {
    return titleMatch[1].trim();
  }

  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ? firstLine.slice(0, 100) : "Image Analysis";
}

function parseDescription(content: string): string {
  const withoutTitle = content.replace(/title[:\s]+(.+?)(?:\n|$)/i, "").trim();
  const withoutDescriptionLabel = withoutTitle.replace(/^description[:\s]+/i, "").trim();
  return withoutDescriptionLabel.length > 0 ? withoutDescriptionLabel : content.trim();
}

export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string
): Promise<ImageDescriptionResult> {
  const openrouter = createOpenRouterProvider(runtime);
  const modelName = getImageModel(runtime);

  const imageUrl = typeof params === "string" ? params : params.imageUrl;
  const prompt =
    typeof params === "string"
      ? DEFAULT_IMAGE_DESCRIPTION_PROMPT
      : (params.prompt ?? DEFAULT_IMAGE_DESCRIPTION_PROMPT);

  if (!imageUrl || imageUrl.trim().length === 0) {
    throw new Error("[OpenRouter] IMAGE_DESCRIPTION requires a valid image URL.");
  }

  try {
    const generateParams = {
      model: openrouter.chat(modelName) as LanguageModel,
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: prompt },
            { type: "image" as const, image: imageUrl },
          ],
        },
      ],
    };

    const response = await generateText(generateParams);

    if (response.usage) {
      emitModelUsageEvent(runtime, ModelType.IMAGE_DESCRIPTION, prompt, response.usage, modelName);
    }

    return {
      title: parseTitle(response.text),
      description: parseDescription(response.text),
    };
  } catch (error: unknown) {
    // error-policy:J2 context-adding rethrow — never fabricate a description;
    // the provider failure surfaces to the caller unchanged.
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error describing image: ${message}`);
    throw error instanceof Error ? error : new Error(message);
  }
}

export async function handleImageGeneration(
  runtime: IAgentRuntime,
  params: ImageGenerationParams
): Promise<{ imageUrl: string; caption?: string }> {
  const openrouter = createOpenRouterProvider(runtime);
  const modelName = getImageGenerationModel(runtime);
  const prompt = params.prompt?.trim();

  if (!prompt) {
    throw new Error("[OpenRouter] IMAGE generation requires a non-empty prompt.");
  }

  try {
    const generateParams = {
      model: openrouter.chat(modelName) as LanguageModel,
      prompt: `Generate an image: ${prompt}`,
    };

    const response = await generateText(generateParams);

    if (response.usage) {
      emitModelUsageEvent(runtime, ModelType.IMAGE, params.prompt, response.usage, modelName);
    }

    return {
      imageUrl: response.text,
      caption: prompt,
    };
  } catch (error: unknown) {
    // error-policy:J2 context-adding rethrow — never fabricate an image URL;
    // the provider failure surfaces to the caller unchanged.
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error generating image: ${message}`);
    throw error instanceof Error ? error : new Error(message);
  }
}

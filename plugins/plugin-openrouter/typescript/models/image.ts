/**
 * Image model handlers for OpenRouter.
 */

import type { IAgentRuntime, ImageDescriptionParams, ImageGenerationParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText } from "ai";

import { createOpenRouterProvider } from "../providers";
import { getImageGenerationModel, getImageModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

/**
 * IMAGE_DESCRIPTION model handler.
 */
export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string
): Promise<string> {
  const openrouter = createOpenRouterProvider(runtime);
  const modelName = getImageModel(runtime);

  logger.log(`[OpenRouter] Using IMAGE_DESCRIPTION model: ${modelName}`);

  const imageUrl = typeof params === "string" ? params : params.imageUrl;
  const prompt =
    typeof params === "string" ? "Describe this image" : params.prompt || "Describe this image";

  try {
    const generateParams = {
      model: openrouter.chat(modelName),
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

    // @ts-expect-error - AI SDK type compatibility issue with OpenRouter provider
    const response = await generateText(generateParams);

    if (response.usage) {
      emitModelUsageEvent(runtime, ModelType.IMAGE_DESCRIPTION, prompt, response.usage);
    }

    return response.text;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error describing image: ${message}`);
    throw error instanceof Error ? error : new Error(message);
  }
}

/**
 * IMAGE generation model handler.
 */
export async function handleImageGeneration(
  runtime: IAgentRuntime,
  params: ImageGenerationParams
): Promise<{ imageUrl: string; caption?: string }> {
  const openrouter = createOpenRouterProvider(runtime);
  const modelName = getImageGenerationModel(runtime);

  logger.log(`[OpenRouter] Using IMAGE generation model: ${modelName}`);

  try {
    const generateParams = {
      model: openrouter.chat(modelName),
      prompt: `Generate an image: ${params.prompt}`,
    };

    // @ts-expect-error - AI SDK type compatibility issue with OpenRouter provider
    const response = await generateText(generateParams);

    if (response.usage) {
      emitModelUsageEvent(runtime, ModelType.IMAGE, params.prompt, response.usage);
    }

    // The response format depends on the model
    // For now, return the text which may contain image URL or base64
    return {
      imageUrl: response.text,
      caption: params.prompt,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error generating image: ${message}`);
    throw error instanceof Error ? error : new Error(message);
  }
}

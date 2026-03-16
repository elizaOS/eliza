import type { IAgentRuntime, ImageDescriptionParams, ImageGenerationParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText, type LanguageModel } from "ai";

import { createOpenRouterProvider } from "../providers";
import { getImageGenerationModel, getImageModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string
): Promise<string> {
  const openrouter = createOpenRouterProvider(runtime);
  const modelName = getImageModel(runtime);

  const imageUrl = typeof params === "string" ? params : params.imageUrl;
  const prompt =
    typeof params === "string" ? "Describe this image" : params.prompt || "Describe this image";

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
      emitModelUsageEvent(runtime, ModelType.IMAGE_DESCRIPTION, prompt, response.usage);
    }

    return response.text;
  } catch (error: unknown) {
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

  try {
    const generateParams = {
      model: openrouter.chat(modelName) as LanguageModel,
      prompt: `Generate an image: ${params.prompt}`,
    };

    const response = await generateText(generateParams);

    if (response.usage) {
      emitModelUsageEvent(runtime, ModelType.IMAGE, params.prompt, response.usage);
    }

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

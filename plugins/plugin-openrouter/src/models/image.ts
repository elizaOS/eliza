import {
  logger,
  type IAgentRuntime,
  type ImageDescriptionParams,
  type ImageGenerationParams,
} from "@elizaos/core";
import { generateText } from "ai";
import type { OpenRouterImageResponse } from "../types";
import { createOpenRouterProvider } from "../providers";
import {
  getApiKey,
  getBaseURL,
  getImageGenerationModel,
  getImageModel,
  shouldAutoCleanupImages,
} from "../utils/config";
import { parseImageDescriptionResponse } from "../utils/helpers";
import { deleteImage, saveBase64Image } from "../utils/image-storage";

/**
 * IMAGE_DESCRIPTION model handler
 */
export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string,
): Promise<{ title: string; description: string }> {
  let imageUrl: string;
  let promptText: string | undefined;
  const modelName = getImageModel(runtime);
  logger.log(`[OpenRouter] Using IMAGE_DESCRIPTION model: ${modelName}`);
  const maxOutputTokens = 300;

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

  const openrouter = createOpenRouterProvider(runtime);

  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: promptText },
        { type: "image" as const, image: imageUrl },
      ],
    },
  ];

  try {
    const model = openrouter.chat(modelName);

    const { text: responseText } = await generateText({
      model: model,
      messages: messages,
      maxOutputTokens: maxOutputTokens,
    });

    return parseImageDescriptionResponse(responseText);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error analyzing image: ${message}`);
    return {
      title: "Failed to analyze image",
      description: `Error: ${message}`,
    };
  }
}

/**
 * IMAGE model handler for image generation
 */
export async function handleImageGeneration(
  runtime: IAgentRuntime,
  params: ImageGenerationParams,
): Promise<{ url: string }[]> {
  const modelName = getImageGenerationModel(runtime);
  logger.log(`[OpenRouter] Using IMAGE_GENERATION model: ${modelName}`);
  const apiKey = getApiKey(runtime);

  try {
    const baseUrl = getBaseURL(runtime);
    const isBrowser =
      typeof globalThis !== "undefined" && (globalThis as any).document;
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        ...(isBrowser ? {} : { Authorization: `Bearer ${apiKey}` }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          {
            role: "user",
            content: params.prompt,
          },
        ],
        modalities: ["image", "text"],
      }),
      // 60 seconds timeout
      signal: AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${response.status} ${response.statusText} ${errorText}`,
      );
    }

    const result = (await response.json()) as OpenRouterImageResponse;

    const images: { url: string; filepath?: string }[] = [];
    const savedPaths: string[] = [];

    // Extract images from the response
    if (result.choices?.[0]?.message?.images) {
      for (const [index, image] of result.choices[0].message.images.entries()) {
        const base64Url = image.image_url.url;

        // Save image to disk
        const filepath = await saveBase64Image(
          base64Url,
          runtime.agentId,
          index,
        );
        if (filepath) {
          // Return the actual file path for Discord/Telegram compatibility
          logger.log(`[OpenRouter] Returning image with filepath: ${filepath}`);
          images.push({
            url: filepath, // Use actual file path
          });
          savedPaths.push(filepath);
        } else if (!base64Url.startsWith("data:")) {
          // If not base64, return as is (might be a URL)
          images.push({ url: base64Url });
        } else {
          // Failed to save base64 image
          logger.warn(
            `[OpenRouter] Failed to save image ${index + 1}, skipping`,
          );
        }
      }
    }

    // Clean up images after a short delay if auto-cleanup is enabled
    if (savedPaths.length > 0 && shouldAutoCleanupImages(runtime)) {
      setTimeout(() => {
        savedPaths.forEach((path) => {
          deleteImage(path);
        });
      }, 30000); // Delete after 30 seconds
    }

    if (images.length === 0) {
      throw new Error("No images generated in response");
    }

    logger.log(`[OpenRouter] Generated ${images.length} image(s)`);
    return images;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[OpenRouter] Error generating image: ${message}`);
    return [];
  }
}

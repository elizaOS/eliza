import type { IAgentRuntime, ImageDescriptionParams, ImageDescriptionResult } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText } from "ai";
import { createAnthropicClientWithTopPSupport } from "../providers";
import { getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { executeWithRetry, formatModelError, sanitizeUrlForLogs } from "../utils/retry";

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
  return withoutTitle.length > 0 ? withoutTitle : content.trim();
}

export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string
): Promise<ImageDescriptionResult> {
  const anthropic = createAnthropicClientWithTopPSupport(runtime);
  const modelName = getSmallModel(runtime);
  const imageUrl = typeof params === "string" ? params : params.imageUrl;
  const promptText =
    typeof params === "string"
      ? DEFAULT_IMAGE_DESCRIPTION_PROMPT
      : (params.prompt ?? DEFAULT_IMAGE_DESCRIPTION_PROMPT);
  const operationName = `${ModelType.IMAGE_DESCRIPTION} request using ${modelName}`;

  if (!imageUrl || imageUrl.trim().length === 0) {
    throw new Error("[Anthropic] IMAGE_DESCRIPTION requires a valid image URL.");
  }

  logger.log(`[Anthropic] Using ${ModelType.IMAGE_DESCRIPTION} model: ${modelName}`);

  try {
    const response = await executeWithRetry(operationName, () =>
      generateText({
        model: anthropic(modelName),
        messages: [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: promptText },
              { type: "image" as const, image: imageUrl },
            ],
          },
        ],
        maxOutputTokens: 1_024,
      })
    );

    if (response.usage) {
      emitModelUsageEvent(
        runtime,
        ModelType.IMAGE_DESCRIPTION,
        promptText,
        response.usage,
        modelName
      );
    }

    return {
      title: parseTitle(response.text),
      description: parseDescription(response.text),
    };
  } catch (error) {
    logger.error(
      `[Anthropic] IMAGE_DESCRIPTION failed for ${modelName} ` +
        `(${sanitizeUrlForLogs(imageUrl)}): ${error instanceof Error ? error.message : String(error)}`
    );
    throw formatModelError(operationName, error);
  }
}

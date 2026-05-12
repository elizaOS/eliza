import type {
  IAgentRuntime,
  ImageDescriptionParams,
  RecordLlmCallDetails,
} from "@elizaos/core";
import { logger, recordLlmCall } from "@elizaos/core";
import type { ImageDescriptionResponse } from "../types";
import {
  createGoogleGenAI,
  getImageModel,
  getSafetySettings,
} from "../utils/config";
import { countTokens } from "../utils/tokenization";

export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string,
): Promise<ImageDescriptionResponse> {
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error("Google Generative AI client not initialized");
  }

  let imageUrl: string;
  let promptText: string;
  const modelName = getImageModel(runtime);
  logger.log(`[IMAGE_DESCRIPTION] Using model: ${modelName}`);

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

  try {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
    }

    const imageData = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageData).toString("base64");
    const contentType =
      imageResponse.headers.get("content-type") || "image/jpeg";

    const details: RecordLlmCallDetails = {
      model: modelName,
      systemPrompt: "",
      userPrompt: promptText,
      temperature: 0.7,
      maxTokens: 8192,
      purpose: "external_llm",
      actionType: "google-genai.IMAGE_DESCRIPTION.generateContent",
    };
    const response = await recordLlmCall(runtime, details, async () => {
      const result = await genAI.models.generateContent({
        model: modelName,
        contents: [
          {
            role: "user",
            parts: [
              { text: promptText },
              {
                inlineData: {
                  mimeType: contentType,
                  data: base64Image,
                },
              },
            ],
          },
        ],
        config: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 8192,
          safetySettings: getSafetySettings(),
        },
      });
      const responseText = result.text || "";
      details.response = responseText;
      details.promptTokens = await countTokens(promptText);
      details.completionTokens = await countTokens(responseText);
      return result;
    });

    const responseText = response.text || "";

    try {
      const jsonResponse = JSON.parse(responseText) as {
        title?: string;
        description?: string;
      };
      if (
        typeof jsonResponse.title === "string" &&
        typeof jsonResponse.description === "string"
      ) {
        return {
          title: jsonResponse.title,
          description: jsonResponse.description,
        };
      }
    } catch {
      // Fall through to text parsing
    }

    const titleMatch = responseText.match(/title[:\s]+(.+?)(?:\n|$)/i);
    const title = titleMatch?.[1]?.trim() || "Image Analysis";
    const description = titleMatch
      ? responseText.replace(/title[:\s]+(.+?)(?:\n|$)/i, "").trim()
      : responseText.trim();

    return { title, description };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error analyzing image: ${message}`);
    return {
      title: "Failed to analyze image",
      description: `Error: ${message}`,
    };
  }
}

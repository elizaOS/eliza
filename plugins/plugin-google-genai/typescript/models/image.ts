import type { IAgentRuntime, ImageDescriptionParams } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { GoogleGenAIImageDescriptionResult } from "../types";
import { createGoogleGenAI, getImageModel, getSafetySettings } from "../utils/config";

// Use global fetch for cross-platform compatibility
const crossFetch = typeof globalThis.fetch === "function" ? globalThis.fetch : fetch;

export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string
): Promise<GoogleGenAIImageDescriptionResult> {
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
    promptText = "Please analyze this image and provide a title and detailed description.";
  } else {
    imageUrl = params.imageUrl;
    promptText =
      params.prompt || "Please analyze this image and provide a title and detailed description.";
  }

  try {
    // Fetch image data using cross-platform fetch
    const imageResponse = await crossFetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
    }

    const imageData = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageData).toString("base64");

    // Determine MIME type from URL or response headers
    const contentType = imageResponse.headers.get("content-type") || "image/jpeg";

    const response = await genAI.models.generateContent({
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

    const responseText = response.text || "";

    logger.log("Received response for image description");

    // Try to parse the response as JSON first
    try {
      const jsonResponse = JSON.parse(responseText) as Record<string, unknown>;
      if (typeof jsonResponse.title === "string" && typeof jsonResponse.description === "string") {
        return {
          title: jsonResponse.title,
          description: jsonResponse.description,
        };
      }
    } catch (e) {
      // If not valid JSON, process as text
      logger.debug(`Parsing as JSON failed, processing as text: ${e}`);
    }

    // Extract title and description from text format
    // For custom prompts, use the full response as description
    const titleMatch = responseText.match(/title[:\s]+(.+?)(?:\n|$)/i);
    const title = titleMatch?.[1]?.trim() || "Image Analysis";
    const description = titleMatch
      ? responseText.replace(/title[:\s]+(.+?)(?:\n|$)/i, "").trim()
      : responseText.trim();

    return { title, description };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error analyzing image: ${message}`);
    return {
      title: "Failed to analyze image",
      description: `Error: ${message}`,
    };
  }
}

/**
 * `IMAGE_DESCRIPTION` handler: fetches an image by URL, encodes it inline, and
 * asks the multimodal Gemini model for a `{ title, description }`. Prefers the
 * model's JSON output and falls back to regex title extraction from prose. The
 * call is wrapped in `recordLlmCall` for trajectory capture.
 *
 * Image bytes are loaded only through `fetchRemoteMedia` so caller-supplied URLs
 * cannot reach loopback, link-local, or private network targets (SSRF). Provider
 * failures (image fetch error, bad key, model-not-found, rate-limit, timeout,
 * safety block, empty completion) surface as typed errors so the caller and
 * model see a real failure — they are never fabricated into a
 * `{ title, description }` result the runtime would read as a real description.
 */
import type {
  IAgentRuntime,
  ImageDescriptionParams,
  RecordLlmCallDetails,
} from "@elizaos/core";
import { fetchRemoteMedia, logger, recordLlmCall } from "@elizaos/core";
import type { ImageDescriptionResponse } from "../types";
import {
  createGoogleGenAI,
  getImageModel,
  getSafetySettings,
} from "../utils/config";
import { countTokens } from "../utils/tokenization";

/** Cap inline image payloads so a hostile host cannot force unbounded memory. */
const IMAGE_DESCRIPTION_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_DESCRIPTION_FETCH_TIMEOUT_MS = 15_000;
const IMAGE_DESCRIPTION_MAX_REDIRECTS = 5;

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

  if (!imageUrl || imageUrl.trim().length === 0) {
    throw new Error("IMAGE_DESCRIPTION requires a valid image URL");
  }

  try {
    // Untrusted agent/tool image URLs must not hit private or metadata hosts.
    const media = await fetchRemoteMedia({
      url: imageUrl,
      maxBytes: IMAGE_DESCRIPTION_MAX_BYTES,
      timeoutMs: IMAGE_DESCRIPTION_FETCH_TIMEOUT_MS,
      maxRedirects: IMAGE_DESCRIPTION_MAX_REDIRECTS,
    });
    const base64Image = media.buffer.toString("base64");
    const contentType = media.contentType || "image/jpeg";

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

    const responseText = (response.text || "").trim();
    if (!responseText) {
      // An empty completion is a provider failure (safety block, truncation,
      // model error), not a describable image. Surface it instead of returning
      // a fabricated "Image Analysis" / empty-description result.
      throw new Error("Google GenAI API returned an empty image description");
    }

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
      // error-policy:J3 untrusted-input sanitizing — a non-JSON completion is
      // an expected model-output shape; fall through to prose title parsing.
    }

    const titleMatch = responseText.match(/title[:\s]+(.+?)(?:\n|$)/i);
    const title = titleMatch?.[1]?.trim() || "Image Analysis";
    const description = titleMatch
      ? responseText.replace(/title[:\s]+(.+?)(?:\n|$)/i, "").trim()
      : responseText;

    return { title, description };
  } catch (error) {
    // error-policy:J2 context-adding rethrow — do not fabricate a
    // `{ title, description }` on failure; the caller/model must see the real
    // error, not an "Error: ..." string dressed up as a successful description.
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error analyzing image: ${message}`);
    throw error instanceof Error ? error : new Error(message);
  }
}

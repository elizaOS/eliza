/**
 * `IMAGE_DESCRIPTION` handler: fetches an image by URL, encodes it inline, and
 * asks the multimodal Gemini model for a `{ title, description }`. Prefers the
 * model's JSON output and falls back to regex title extraction from prose. The
 * call is wrapped in `recordLlmCall` for trajectory capture.
 *
 * Image bytes are loaded only through the platform-installed guarded fetcher
 * (`models/image-url.ts`) so caller-supplied URLs cannot reach loopback,
 * link-local, or private network targets (SSRF), and so this shared module
 * never names a Node-only core subpath a browser bundle would follow. Provider
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
import { ElizaError, logger, recordLlmCall } from "@elizaos/core";
import type { ImageDescriptionResponse } from "../types";
import {
  createGoogleGenAI,
  getImageModel,
  getSafetySettings,
} from "../utils/config";
import { countTokens } from "../utils/tokenization";
import { fetchImageFromUrl } from "./image-url";

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
    // Each build entrypoint installs its platform's guarded fetcher, so this
    // shared module never names the Node-only `@elizaos/core/node` subpath.
    const media = await fetchImageFromUrl(imageUrl);
    const base64Image = media.base64;
    const contentType = media.contentType || "image/jpeg";

    const details: RecordLlmCallDetails = {
      model: modelName,
      systemPrompt: "",
      userPrompt: promptText,
      temperature: 0.7,
      maxTokens: 0,
      maxTokensOmitted: true,
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
          safetySettings: getSafetySettings(),
        },
      });
      const responseText = result.text || "";
      const finishReason = result.candidates?.find(
        (candidate) => candidate.finishReason,
      )?.finishReason;
      if (finishReason?.toUpperCase() === "MAX_TOKENS") {
        throw new ElizaError(
          "Google GenAI reached its output boundary; refusing partial image description",
          {
            code: "MODEL_INCOMPLETE_OUTPUT",
            context: { provider: "google-genai", finishReason },
          },
        );
      }
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

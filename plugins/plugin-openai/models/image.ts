/**
 * Image model handlers: `handleImageGeneration` (dall-e-3 `/images/generations`)
 * and `handleImageDescription`, which sends the image to a vision chat model and
 * returns a `{ title, description }` pair.
 */
import type {
  IAgentRuntime,
  ImageDescriptionParams,
  ImageGenerationParams,
  RecordLlmCallDetails,
} from "@elizaos/core";
import { logger, ModelType, recordLlmCall } from "@elizaos/core";
import type {
  ImageDescriptionResult,
  ImageGenerationResult,
  ImageQuality,
  ImageSize,
  ImageStyle,
  OpenAIChatCompletionResponse,
  OpenAIImageGenerationResponse,
} from "../types";
import {
  getAuthHeader,
  getBaseURL,
  getImageDescriptionAuthHeader,
  getImageDescriptionBaseURL,
  getImageDescriptionMaxTokens,
  getImageDescriptionModel,
  getImageModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

interface ExtendedImageGenerationParams extends ImageGenerationParams {
  quality?: ImageQuality;
  style?: ImageStyle;
}

const DEFAULT_IMAGE_DESCRIPTION_PROMPT =
  "Please analyze this image and provide a title and detailed description.";

const IMAGE_GENERATION_TIMEOUT_MS = 120_000;

const IMAGE_DESCRIPTION_TIMEOUT_MS = 45_000;

export async function handleImageGeneration(
  runtime: IAgentRuntime,
  params: ImageGenerationParams
): Promise<ImageGenerationResult[]> {
  const modelName = getImageModel(runtime);
  const count = params.count ?? 1;
  const size: ImageSize = (params.size as ImageSize) ?? "1024x1024";
  const extendedParams = params as ExtendedImageGenerationParams;

  logger.debug(`[OpenAI] Using IMAGE model: ${modelName}`);

  if (typeof params.prompt !== "string" || params.prompt.trim().length === 0) {
    throw new Error("IMAGE generation requires a non-empty prompt");
  }

  if (count < 1 || count > 10) {
    throw new Error("IMAGE count must be between 1 and 10");
  }

  const baseURL = getBaseURL(runtime);

  const requestBody: Record<string, string | number> = {
    model: modelName,
    prompt: params.prompt,
    n: count,
    size,
  };

  if (extendedParams.quality) {
    requestBody.quality = extendedParams.quality;
  }
  if (extendedParams.style) {
    requestBody.style = extendedParams.style;
  }

  const details: RecordLlmCallDetails = {
    model: modelName,
    systemPrompt: "",
    userPrompt: params.prompt,
    temperature: 0,
    maxTokens: 0,
    purpose: "external_llm",
    actionType: "openai.images.generate",
  };
  const data = await recordLlmCall(runtime, details, async () => {
    const response = await fetch(`${baseURL}/images/generations`, {
      method: "POST",
      headers: {
        ...getAuthHeader(runtime),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `OpenAI image generation failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const responseData = (await response.json()) as OpenAIImageGenerationResponse;
    details.response = JSON.stringify(responseData.data);
    return responseData;
  });

  if (data.data.length === 0) {
    throw new Error("OpenAI API returned no images");
  }

  return data.data.map((item) => ({
    url: item.url,
    revisedPrompt: item.revised_prompt,
  }));
}

const DEFAULT_IMAGE_TITLE = "Image Analysis";

// A genuine title line must be the first non-blank content the model emitted,
// e.g. "Title: <text>". Anchoring to the start prevents a mid-sentence mention
// of the word "title" (books, posters, signs, UI screenshots) from hijacking
// the split and truncating the description the agent reasons over.
const LEADING_TITLE_LINE = /^\s*title\s*[:-]\s*(.*?)(?:\r?\n|$)/i;
const LEADING_DESCRIPTION_LABEL = /^\s*description\s*[:-]\s*/i;

/**
 * Splits a vision model's reply into a `{ title, description }` pair. The
 * documented contract shape is a leading `Title:` line followed by the
 * description body (optionally prefixed with a `Description:` label). Any reply
 * that does not start with a title line is treated as description-only so the
 * required `description` field always carries the real image content instead of
 * a silently truncated or emptied value.
 */
function parseImageDescriptionResponse(content: string): {
  title: string;
  description: string;
} {
  const trimmed = content.trim();
  const titleLine = trimmed.match(LEADING_TITLE_LINE);

  if (!titleLine) {
    return { title: DEFAULT_IMAGE_TITLE, description: trimmed };
  }

  const titleText = titleLine[1]?.trim() ?? "";
  const remainder = trimmed.slice(titleLine[0].length).trim();

  if (remainder.length > 0) {
    const description = remainder.replace(LEADING_DESCRIPTION_LABEL, "").trim();
    return {
      title: titleText.length > 0 ? titleText : DEFAULT_IMAGE_TITLE,
      description,
    };
  }

  // Single labelled line with no separate body: the labelled text is the only
  // content the model returned, so preserve it as the description rather than
  // dropping it and fall back to the default title.
  return { title: DEFAULT_IMAGE_TITLE, description: titleText };
}

export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string
): Promise<ImageDescriptionResult> {
  const modelName = getImageDescriptionModel(runtime);
  const paramsWithMaxTokens = params as ImageDescriptionParams & { maxTokens?: number };
  const maxTokens =
    typeof params === "object" && typeof paramsWithMaxTokens.maxTokens === "number"
      ? paramsWithMaxTokens.maxTokens
      : getImageDescriptionMaxTokens(runtime);
  logger.debug(`[OpenAI] Using IMAGE_DESCRIPTION model: ${modelName}`);

  let imageUrl: string;
  let promptText: string;

  if (typeof params === "string") {
    imageUrl = params;
    promptText = DEFAULT_IMAGE_DESCRIPTION_PROMPT;
  } else {
    imageUrl = params.imageUrl;
    promptText = params.prompt ?? DEFAULT_IMAGE_DESCRIPTION_PROMPT;
  }

  if (!imageUrl || imageUrl.trim().length === 0) {
    throw new Error("IMAGE_DESCRIPTION requires a valid image URL");
  }

  const baseURL = getImageDescriptionBaseURL(runtime);
  const timeoutSignal = AbortSignal.timeout(IMAGE_DESCRIPTION_TIMEOUT_MS);
  const signal =
    typeof params === "object" && params.signal
      ? AbortSignal.any([params.signal, timeoutSignal])
      : timeoutSignal;

  const requestBody = {
    model: modelName,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptText },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: maxTokens,
  };

  const details: RecordLlmCallDetails = {
    model: modelName,
    systemPrompt: "",
    userPrompt: promptText,
    temperature: 0,
    maxTokens,
    purpose: "external_llm",
    actionType: "openai.chat.completions.create",
  };
  const data = await recordLlmCall(runtime, details, async () => {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        ...getImageDescriptionAuthHeader(runtime),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `OpenAI image description failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const responseData = (await response.json()) as OpenAIChatCompletionResponse;
    const responseContent = responseData.choices[0]?.message.content;
    if (!responseContent) {
      throw new Error("OpenAI API returned empty image description");
    }
    details.response = responseContent;
    if (responseData.usage) {
      details.promptTokens = responseData.usage.prompt_tokens;
      details.completionTokens = responseData.usage.completion_tokens;
    }
    return responseData;
  });

  if (data.usage) {
    emitModelUsageEvent(
      runtime,
      ModelType.IMAGE_DESCRIPTION,
      typeof params === "string" ? params : (params.prompt ?? ""),
      {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      modelName
    );
  }

  const firstChoice = data.choices[0];
  const content = firstChoice?.message.content;

  if (!content) {
    throw new Error("OpenAI API returned empty image description");
  }

  return parseImageDescriptionResponse(content);
}

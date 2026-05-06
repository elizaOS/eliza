import type { IAgentRuntime, ImageDescriptionParams, ImageGenerationParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { getImageDescriptionModel, getImageGenerationModel, getSetting } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { parseImageDescriptionResponse } from "../utils/helpers";
import { createElizaCloudClient } from "../utils/sdk-client";

export async function handleImageGeneration(
  runtime: IAgentRuntime,
  params: ImageGenerationParams
): Promise<{ url: string }[]> {
  const numImages = params.count || 1;
  const size = params.size || "1024x1024";
  const prompt = params.prompt;
  const modelName = getImageGenerationModel(runtime);
  logger.log(`[ELIZAOS_CLOUD] Using IMAGE model: ${modelName}`);

  const aspectRatioMap: Record<string, string> = {
    "1024x1024": "1:1",
    "1792x1024": "16:9",
    "1024x1792": "9:16",
  };
  const aspectRatio = aspectRatioMap[size] || "1:1";

  try {
    const requestBody = {
      prompt: prompt,
      numImages: numImages,
      aspectRatio: aspectRatio,
      model: modelName,
    };

    const typedData = await createElizaCloudClient(runtime).generateImage(requestBody);

    const result = typedData.images.map((img) => ({
      url: img.url || img.image,
    }));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[ELIZAOS_CLOUD] Image generation error: ${message}`);
    throw error;
  }
}

export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string
): Promise<{ title: string; description: string }> {
  // Honour `DISABLE_IMAGE_DESCRIPTION` (set by the runtime when
  // `features.vision === false`). The runtime exposes it via getSetting; some
  // hosts only set it in process.env. Check both before burning a quota slot.
  // The docs (`docs/runtime/core.md`) already promise this behaviour, but
  // historically only `plugin-discord` honoured it at the call site, leaving
  // every other caller (agent-orchestrator's task validator, vision, lifeops,
  // farcaster, telegram) free to spend the rate-limit budget.
  const disableSetting = getSetting(runtime, "DISABLE_IMAGE_DESCRIPTION", "");
  const disabled =
    disableSetting === "true" ||
    disableSetting === "1" ||
    process.env.DISABLE_IMAGE_DESCRIPTION === "true" ||
    process.env.DISABLE_IMAGE_DESCRIPTION === "1";
  if (disabled) {
    logger.debug("[ELIZAOS_CLOUD] IMAGE_DESCRIPTION skipped — DISABLE_IMAGE_DESCRIPTION is set");
    return {
      title: "Image description disabled",
      description: "Image description is disabled by configuration.",
    };
  }

  let imageUrl: string;
  let promptText: string | undefined;
  const modelName = getImageDescriptionModel(runtime);
  logger.log(`[ELIZAOS_CLOUD] Using IMAGE_DESCRIPTION model: ${modelName}`);
  const maxTokens = Number.parseInt(
    getSetting(runtime, "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS", "8192") || "8192",
    10
  );

  if (typeof params === "string") {
    imageUrl = params;
    promptText = "Please analyze this image and provide a title and detailed description.";
  } else {
    imageUrl = params.imageUrl;
    promptText =
      params.prompt || "Please analyze this image and provide a title and detailed description.";
  }

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: promptText },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ];

  const client = createElizaCloudClient(runtime);

  try {
    const requestBody: Record<string, unknown> = {
      model: modelName,
      messages: messages,
      max_tokens: maxTokens,
    };

    // On 429, honour the upstream's `retryAfter` instead of retrying on a
    // hardcoded backoff. Hardcoded retries inside the rate-limit window add
    // wasted requests to the same bucket and make the problem worse — see
    // #7374's billing render-loop fix and S33's dashboard 429-aware UX.
    // Strategy: only retry once, only if the upstream signals a short wait
    // (≤5s, i.e. transient burst). Anything longer, bail immediately and let
    // the caller fail fast.
    let response: Response | null = null;
    let attemptedRetry = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await client.routes.postApiV1ChatCompletionsRaw({
        json: requestBody,
      });
      if (response.status !== 429 || attemptedRetry) break;

      // `Number(null) === 0`, so guard against a missing header before
      // calling `Number(...)` — otherwise the header path always wins with a
      // bogus `0` and the body fallback becomes unreachable.
      const headerValue = response.headers.get("retry-after");
      const headerRetryAfter =
        headerValue !== null && Number.isFinite(Number(headerValue))
          ? Number(headerValue)
          : undefined;
      let bodyRetryAfter: number | undefined;
      try {
        const peek = (await response.clone().json()) as {
          retryAfter?: unknown;
        };
        bodyRetryAfter =
          typeof peek?.retryAfter === "number" && Number.isFinite(peek.retryAfter)
            ? peek.retryAfter
            : undefined;
      } catch {
        // Body wasn't JSON — fall through to header value.
      }
      const retryAfter = headerRetryAfter ?? bodyRetryAfter ?? 0;

      if (retryAfter > 0 && retryAfter <= 5) {
        logger.warn(
          `[ELIZAOS_CLOUD] Image analysis rate-limited (429), retrying once after ${retryAfter}s...`
        );
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        attemptedRetry = true;
        continue;
      }
      // Long rate-limit window: don't burn another bucket slot retrying inside it.
      logger.warn(
        `[ELIZAOS_CLOUD] Image analysis rate-limited (429); upstream retryAfter=${retryAfter || "unknown"}s — failing fast`
      );
      break;
    }

    if (!response?.ok) {
      const status = response?.status ?? 0;
      if (status === 402) {
        throw new Error(
          "Eliza Cloud credits exhausted — top up at https://www.elizacloud.ai/dashboard/settings?tab=billing"
        );
      }
      if (status === 429) {
        throw new Error(
          "Eliza Cloud rate limit exceeded for image description — try again in a minute"
        );
      }
      throw new Error(`ElizaOS Cloud API error: ${status}`);
    }

    type OpenAIResponseType = {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const typedResult = (await response.json()) as OpenAIResponseType;
    const content = typedResult.choices?.[0]?.message?.content;

    if (typedResult.usage) {
      emitModelUsageEvent(
        runtime,
        ModelType.IMAGE_DESCRIPTION,
        typeof params === "string" ? params : params.prompt || "",
        {
          inputTokens: typedResult.usage.prompt_tokens,
          outputTokens: typedResult.usage.completion_tokens,
          totalTokens: typedResult.usage.total_tokens,
        }
      );
    }

    if (!content) {
      return {
        title: "Failed to analyze image",
        description: "No response from API",
      };
    }

    return parseImageDescriptionResponse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error analyzing image: ${message}`);
    return {
      title: "Failed to analyze image",
      description: `Error: ${message}`,
    };
  }
}

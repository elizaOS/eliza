import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { OpenAIPluginConfig } from "./types";
import { getApiKey, getAuthHeader, getBaseURL, isBrowser } from "./utils/config";

(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS ??= false;

export function initializeOpenAI(
  _config: OpenAIPluginConfig | undefined,
  runtime: IAgentRuntime
): void {
  void validateOpenAIConfiguration(runtime);
}

async function validateOpenAIConfiguration(runtime: IAgentRuntime): Promise<void> {
  if (isBrowser()) {
    logger.debug("[OpenAI] Skipping API validation in browser environment");
    return;
  }

  const apiKey = getApiKey(runtime);

  if (!apiKey) {
    logger.warn(
      "[OpenAI] OPENAI_API_KEY is not configured. " +
        "OpenAI functionality will fail until a valid API key is provided."
    );
    return;
  }

  try {
    const baseURL = getBaseURL(runtime);
    const response = await fetch(`${baseURL}/models`, {
      headers: getAuthHeader(runtime),
    });

    if (!response.ok) {
      logger.warn(
        `[OpenAI] API key validation failed: ${response.status} ${response.statusText}. ` +
          "Please verify your OPENAI_API_KEY is correct."
      );
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[OpenAI] API validation error: ${message}. OpenAI functionality may be limited.`);
  }
}

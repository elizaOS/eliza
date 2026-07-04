/**
 * Startup validation for the OpenAI provider, run from the plugin's `init`: it
 * fires a best-effort `GET /models` against the resolved base URL so a missing
 * or invalid key surfaces as an early warning rather than a first-call failure.
 * Browser builds skip the check (no server-side key). Also silences the AI SDK
 * warning log globally.
 */
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
    // error-policy:J7 diagnostics-must-not-kill-the-loop — key validation is an
    // advisory startup probe; a network/transport failure must not block plugin
    // init. The real request failure surfaces at call time on the model path.
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[OpenAI] API validation error: ${message}. OpenAI functionality may be limited.`);
  }
}

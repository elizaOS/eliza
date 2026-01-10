/**
 * OpenAI plugin initialization
 *
 * Validates configuration and API connectivity on startup.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { OpenAIPluginConfig } from "./types";
import { getApiKey, getAuthHeader, getBaseURL, isBrowser } from "./utils/config";

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initializes and validates OpenAI configuration.
 *
 * Performs background validation of the API key by fetching
 * the models list. Does not block plugin initialization.
 *
 * @param _config - Plugin configuration (may be undefined)
 * @param runtime - The agent runtime
 */
export function initializeOpenAI(
  _config: OpenAIPluginConfig | undefined,
  runtime: IAgentRuntime
): void {
  // Run validation in background without blocking
  void validateOpenAIConfiguration(runtime);
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates OpenAI API configuration and connectivity.
 *
 * @param runtime - The agent runtime
 */
async function validateOpenAIConfiguration(runtime: IAgentRuntime): Promise<void> {
  // Skip validation in browser environments
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
    logger.warn(
      `[OpenAI] API validation error: ${message}. ` +
        "OpenAI functionality may be limited."
    );
  }
}

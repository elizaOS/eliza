/**
 * Anthropic plugin initialization.
 *
 * Validates configuration and logs status at startup.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import type { PluginConfig } from "./index";
import { getApiKeyOptional, isBrowser } from "./utils/config";

// ============================================================================
// Suppress AI SDK Warnings
// ============================================================================

// Disable AI SDK warning logging by default (can be overridden by setting to true)
const _globalThis = globalThis as Record<string, unknown>;
if (_globalThis['AI_SDK_LOG_WARNINGS'] === undefined) {
  _globalThis['AI_SDK_LOG_WARNINGS'] = false;
}

/**
 * Initialize and validate Anthropic configuration.
 *
 * This function runs validation in the background to avoid blocking
 * plugin initialization. It logs warnings if configuration is missing.
 */
export function initializeAnthropic(_config: PluginConfig, runtime: IAgentRuntime): void {
  // Run validation asynchronously to not block init
  void (async () => {
    const apiKey = getApiKeyOptional(runtime);

    if (!apiKey && !isBrowser()) {
      logger.warn(
        "ANTHROPIC_API_KEY is not set in environment - Anthropic functionality will be limited. " +
          "Set ANTHROPIC_API_KEY in your environment variables or runtime settings.",
      );
      return;
    }

    if (apiKey) {
      logger.log("Anthropic API key configured successfully");
    }
  })();
}

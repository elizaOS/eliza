/**
 * OpenRouter plugin initialization.
 */

import { logger, type IAgentRuntime } from '@elizaos/core';
import { getApiKey, getBaseURL } from './utils/config';

// Disable AI SDK warning logging by default (can be overridden by setting to true)
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS ??= false;

/**
 * Initialize and validate OpenRouter configuration.
 */
export function initializeOpenRouter(_config: Record<string, unknown>, runtime: IAgentRuntime): void {
  // Do check in the background
  (async () => {
    try {
      const isBrowser = typeof globalThis !== 'undefined' && (globalThis as Record<string, unknown>).document;
      // In browser, skip validation entirely to avoid exposing secrets
      if (isBrowser) {
        return;
      }

      if (!getApiKey(runtime)) {
        logger.warn(
          'OPENROUTER_API_KEY is not set in environment - OpenRouter functionality will be limited'
        );
        return;
      }

      try {
        const baseURL = getBaseURL(runtime);
        // Use global fetch which works in both Node.js 18+ and browsers
        const response = await fetch(`${baseURL}/models`, {
          headers: { Authorization: `Bearer ${getApiKey(runtime)}` },
        });

        if (!response.ok) {
          logger.warn(`OpenRouter API key validation failed: ${response.statusText}`);
          logger.warn(
            'OpenRouter functionality will be limited until a valid API key is provided'
          );
        } else {
          logger.log('OpenRouter API key validated successfully');
        }
      } catch (fetchError: unknown) {
        const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
        logger.warn(`Error validating OpenRouter API key: ${message}`);
        logger.warn('OpenRouter functionality will be limited until a valid API key is provided');
      }
    } catch (error: unknown) {
      const message =
        (error as { errors?: Array<{ message: string }> })?.errors
          ?.map((e) => e.message)
          .join(', ') || (error instanceof Error ? error.message : String(error));
      logger.warn(
        `OpenRouter plugin configuration issue: ${message} - You need to configure the OPENROUTER_API_KEY in your environment variables`
      );
    }
  })();
}

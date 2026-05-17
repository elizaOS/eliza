/**
 * Retry / backoff helpers and structured-output parsing.
 *
 * Exponential backoff capped at `maxDelayMs`. `withRetry` validates each
 * result before accepting it so transient JSON corruption doesn't
 * surface as a "successful" empty response upstream.
 */

import { logger, parseJSONObjectFromText } from "@elizaos/core";

export const RETRY_CONFIG = {
  baseDelayMs: 200,
  maxDelayMs: 1000,
  backoffMultiplier: 2,
} as const;

export function getRetryDelay(attempt: number): number {
  const delay = RETRY_CONFIG.baseDelayMs * RETRY_CONFIG.backoffMultiplier ** (attempt - 1);
  return Math.min(delay, RETRY_CONFIG.maxDelayMs);
}

export function parseStructuredModelObject(raw: string): Record<string, unknown> | null {
  return parseJSONObjectFromText(raw);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  validate: (result: T) => boolean,
  maxRetries: number,
  label: string,
): Promise<T | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      if (validate(result)) {
        logger.debug(`[NativePlanner] ${label} succeeded on attempt ${attempt}`);
        return result;
      }
      logger.warn(`[NativePlanner] ${label} validation failed on attempt ${attempt}/${maxRetries}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        `[NativePlanner] ${label} error on attempt ${attempt}/${maxRetries}:`,
        errorMessage,
      );
      if (attempt >= maxRetries) throw error;
    }

    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, getRetryDelay(attempt)));
    }
  }
  return null;
}

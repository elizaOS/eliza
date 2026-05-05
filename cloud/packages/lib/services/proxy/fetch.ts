import { logger } from "@/lib/utils/logger";

export interface RetryFetchOptions {
  url: string;
  init: RequestInit;
  maxRetries: number;
  initialDelayMs: number;
  timeoutMs: number;
  serviceTag: string;
  nonRetriableStatuses?: number[];
}

/**
 * Sanitize URLs to prevent API key leaks in logs
 *
 * WHY multiple patterns:
 * - Helius: API keys in query params (?api-key=xxx)
 * - Alchemy RPC: API keys in path (/v2/{key})
 * - Alchemy NFT: API keys in path (/v3/{key}/endpoint)
 * - Birdeye: API keys in headers (not in URL, but we sanitize query params just in case)
 */
function sanitizeUrl(url: string): string {
  return url
    .replace(/api-key=[^&]+/gi, "api-key=***") // Helius: ?api-key=xxx
    .replace(/\/v2\/[^/?]+/, "/v2/***") // Alchemy RPC: /v2/{key}
    .replace(/\/v3\/[^/?]+/, "/v3/***"); // Alchemy NFT: /v3/{key}/...
}

/**
 * Shared retry utility with exponential backoff for upstream API calls
 *
 * WHY this exists:
 * - Solana RPC and Market Data API both need retry logic
 * - DRY: prevents code duplication across service handlers
 * - Consistency: all services use same retry strategy
 * - Maintainability: changing retry logic only requires updating one place
 *
 * WHY exponential backoff:
 * - Linear retries can overwhelm already-struggling upstream services
 * - Exponential backoff gives upstream time to recover
 * - Standard pattern: 1s -> 2s -> 4s -> 8s -> 16s
 *
 * WHY API key sanitization:
 * - Many providers (Helius, Birdeye, Alchemy) require API keys in URLs
 * - Logs must never expose API keys for security
 * - Automatic sanitization prevents accidental leaks
 *
 * WHY non-retriable status codes:
 * - 400 Bad Request: client error, retrying won't help
 * - 404 Not Found: resource doesn't exist, retrying won't help
 * - 5xx errors ARE retriable: server issues may be transient
 */
export async function retryFetch(opts: RetryFetchOptions, attempt: number = 1): Promise<Response> {
  const {
    url,
    init,
    maxRetries,
    initialDelayMs,
    timeoutMs,
    serviceTag,
    nonRetriableStatuses = [400, 404],
  } = opts;

  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const sanitizedUrl = sanitizeUrl(url);
    logger.debug(`[${serviceTag}] Attempt`, {
      attempt,
      url: sanitizedUrl,
      status: response.status,
    });

    if (response.ok || nonRetriableStatuses.includes(response.status)) {
      return response;
    }

    if (attempt < maxRetries) {
      const delayMs = initialDelayMs * 2 ** (attempt - 1);
      logger.warn(`[${serviceTag}] Retriable error, retrying`, {
        attempt,
        status: response.status,
        delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return retryFetch(opts, attempt + 1);
    }

    return response;
  } catch (error) {
    const sanitizedUrl = sanitizeUrl(url);

    if (error instanceof Error && error.name === "TimeoutError") {
      logger.warn(`[${serviceTag}] Timeout`, { attempt, url: sanitizedUrl });

      if (attempt < maxRetries) {
        const delayMs = initialDelayMs * 2 ** (attempt - 1);
        logger.info(`[${serviceTag}] Retrying after timeout`, {
          attempt,
          delayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return retryFetch(opts, attempt + 1);
      }
    }

    throw error;
  }
}

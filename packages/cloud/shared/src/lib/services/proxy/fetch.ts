/** Applies the named Cloud proxy transport policy without owning provider authentication. */
import {
  executeResponseAttempts,
  type ResponseReplayPolicy,
} from "@elizaos/cloud-services-common/response-attempts";
import { logger } from "../../utils/logger";

export interface RetryFetchOptions {
  url: string;
  init: RequestInit;
  maxRetries: number;
  initialDelayMs: number;
  timeoutMs: number;
  serviceTag: string;
  nonRetriableStatuses?: number[];
  replayPolicy: ResponseReplayPolicy;
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
export async function retryFetch(opts: RetryFetchOptions): Promise<Response> {
  const {
    url,
    init,
    maxRetries,
    initialDelayMs,
    timeoutMs,
    serviceTag,
    nonRetriableStatuses = [400, 404],
    replayPolicy,
  } = opts;
  const sanitizedUrl = sanitizeUrl(url);
  let result: Awaited<ReturnType<typeof executeResponseAttempts>>;
  try {
    result = await executeResponseAttempts({
      maxAttempts: maxRetries,
      replayPolicy,
      retryStatuses: true,
      retryTransport: true,
      baseDelayMs: initialDelayMs,
      request: () =>
        fetch(url, {
          ...init,
          signal: init.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        }),
      reportObservationError: (error) => {
        logger.warn(`[${serviceTag}] Attempt observation failed`, {
          error: error instanceof Error ? error.message : String(error),
          url: sanitizedUrl,
        });
      },
      observe: (observation) => {
        logger.debug(`[${serviceTag}] Attempt`, {
          attempt: observation.attempt,
          url: sanitizedUrl,
          status: observation.response?.status,
          error:
            observation.error instanceof Error
              ? observation.error.message
              : observation.error
                ? String(observation.error)
                : undefined,
          retryReason: observation.retryReason,
          retryDelayMs: observation.retryDelayMs,
        });
      },
    });
  } catch (error) {
    // error-policy:J1 This proxy boundary preserves the original transport error
    // identity after the shared retry engine records it as the terminal cause.
    if (error instanceof Error && error.cause !== undefined) throw error.cause;
    throw error;
  }
  if (nonRetriableStatuses.includes(result.response.status)) return result.response;
  return result.response;
}

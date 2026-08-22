/**
 * Coordinates cloud service rate-limit retries and typed exhaustion errors behind route handlers.
 */
import type { SocialPlatform } from "../../types/social-media";
import { logger } from "../../utils/logger";

export interface RateLimitError extends Error {
  rateLimited: true;
  retryAfter?: number;
  platform: SocialPlatform;
}

export interface ApiResponse<T> {
  data: T;
}

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  platform: SocialPlatform;
  signal?: AbortSignal;
  deadlineAt?: number;
  minimumAttemptBudgetMs?: number;
}

const PLATFORM_RATE_LIMITS: Record<
  SocialPlatform,
  { requestsPerWindow: number; windowMs: number }
> = {
  twitter: { requestsPerWindow: 300, windowMs: 15 * 60 * 1000 },
  bluesky: { requestsPerWindow: 3000, windowMs: 5 * 60 * 1000 },
  discord: { requestsPerWindow: 50, windowMs: 1000 },
  telegram: { requestsPerWindow: 30, windowMs: 1000 },
  slack: { requestsPerWindow: 50, windowMs: 60 * 1000 }, // Tier 2: ~1 req/sec
  reddit: { requestsPerWindow: 60, windowMs: 60 * 1000 },
  facebook: { requestsPerWindow: 200, windowMs: 60 * 60 * 1000 },
  instagram: { requestsPerWindow: 200, windowMs: 60 * 60 * 1000 },
  tiktok: { requestsPerWindow: 100, windowMs: 60 * 1000 },
  linkedin: { requestsPerWindow: 100, windowMs: 24 * 60 * 60 * 1000 },
  mastodon: { requestsPerWindow: 300, windowMs: 5 * 60 * 1000 },
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      reject(signal?.reason);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Upper bound on how long a single `withRetry` attempt will hold the caller
 * waiting on a provider-supplied `Retry-After`. Both bounds are load-bearing,
 * and both are reachable from a response header we do not control:
 *
 * - **No upper bound** parks the publishing worker for as long as the provider
 *   asks. `Retry-After: 86400` is legal HTTP and pins one attempt for 24h; with
 *   the default `maxRetries = 3` that is four days on one open request.
 * - **`setTimeout` coerces any delay above 2^31-1 ms to 1ms** (Node/Bun emit
 *   `TimeoutOverflowWarning`), so an unclamped wait *inverts* the backoff: the
 *   larger the pause the provider asks for, the faster we retry it.
 *   `Retry-After: 999999999` exhausts the whole retry ladder in milliseconds.
 *   This cap is well below 2^31-1, so no wait computed here can reach that
 *   coercion.
 * - **No lower bound** lets `Retry-After: -1` reach `setTimeout` as a negative
 *   delay (`TimeoutNegativeWarning`), which it also coerces to 1ms.
 *
 * Not reusing `PROVIDER_MAX_BACKOFF_DELAY_MS` (8s, `lib/providers/_http.ts`):
 * that constant is exported so the stale-reservation sweep can derive its grace
 * window from the *LLM provider* ladder, and 8s is far below what social
 * platforms legitimately ask for. The clamp shape here is the same as that
 * module's `computeBackoffMs`.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * Keep a retry wait inside `[0, MAX_RATE_LIMIT_WAIT_MS]` before it reaches
 * `setTimeout`. A non-finite wait clamps to the maximum rather than to zero, so
 * a malformed value slows us down instead of turning into a retry storm.
 *
 * The value parsed off the header is deliberately NOT clamped at the source: it
 * is still reported verbatim on the typed `RateLimitError` so callers can
 * schedule against what the provider actually said (see #20116).
 */
export function clampRateLimitWaitMs(waitMs: number): number {
  if (!Number.isFinite(waitMs)) return MAX_RATE_LIMIT_WAIT_MS;
  return Math.min(Math.max(waitMs, 0), MAX_RATE_LIMIT_WAIT_MS);
}

function retryBudgetError(platform: SocialPlatform): DOMException {
  return new DOMException(`${platform} retry sequence deadline expired`, "TimeoutError");
}

function remainingRetryBudgetMs(
  platform: SocialPlatform,
  deadlineAt: number | undefined,
  minimumAttemptBudgetMs: number,
): number | undefined {
  if (deadlineAt === undefined) return undefined;
  if (!Number.isFinite(deadlineAt)) {
    throw new TypeError("Retry deadlineAt must be finite");
  }
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= minimumAttemptBudgetMs) throw retryBudgetError(platform);
  return remainingMs;
}

function boundedRetryWaitMs(
  requestedMs: number,
  platform: SocialPlatform,
  deadlineAt: number | undefined,
  minimumAttemptBudgetMs: number,
): number {
  const waitMs = clampRateLimitWaitMs(requestedMs);
  const remainingMs = remainingRetryBudgetMs(platform, deadlineAt, minimumAttemptBudgetMs);
  if (remainingMs === undefined) return waitMs;
  return Math.min(waitMs, Math.max(0, remainingMs - minimumAttemptBudgetMs));
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return seconds * 1000;
  const date = new Date(header);
  return isNaN(date.getTime()) ? undefined : Math.max(0, date.getTime() - Date.now());
}

export function isRateLimitResponse(response: Response): boolean {
  return response.status === 429;
}

export function createRateLimitError(
  platform: SocialPlatform,
  retryAfter?: number,
): RateLimitError {
  const error = new Error(`Rate limited by ${platform}`) as RateLimitError;
  error.rateLimited = true;
  error.retryAfter = retryAfter;
  error.platform = platform;
  return error;
}

export async function withRetry<T>(
  fn: () => Promise<Response>,
  parser: (response: Response) => Promise<T>,
  options: RetryOptions,
): Promise<ApiResponse<T>> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    platform,
    signal,
    deadlineAt,
    minimumAttemptBudgetMs = 0,
  } = options;
  if (
    !Number.isSafeInteger(minimumAttemptBudgetMs) ||
    minimumAttemptBudgetMs < 0 ||
    minimumAttemptBudgetMs > 2_147_483_647
  ) {
    throw new TypeError("minimumAttemptBudgetMs must be a non-negative timer-safe integer");
  }
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      signal?.throwIfAborted();
      remainingRetryBudgetMs(platform, deadlineAt, minimumAttemptBudgetMs);
      const response = await fn();

      if (isRateLimitResponse(response)) {
        const retryAfter = parseRetryAfter(response);

        if (attempt < maxRetries) {
          const waitMs = boundedRetryWaitMs(
            retryAfter ?? baseDelayMs * 2 ** attempt,
            platform,
            deadlineAt,
            minimumAttemptBudgetMs,
          );
          logger.warn(
            `[${platform}] Rate limited, waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`,
          );
          await sleep(waitMs, signal);
          continue;
        }
        throw createRateLimitError(
          platform,
          retryAfter !== undefined ? retryAfter / 1000 : undefined,
        );
      }

      if (!response.ok) {
        // error-policy:J6 best-effort error-body read; the HTTP failure still surfaces via the thrown status error below
        const errorBody = await response.text().catch((error) => {
          logger.warn(
            `[${platform}] Failed to read non-ok response body: ${error instanceof Error ? error.message : String(error)}`,
          );
          return "";
        });
        throw new Error(`${platform} API error ${response.status}: ${errorBody}`);
      }

      return { data: await parser(response) };
    } catch (error) {
      // error-policy:J1 outbound social-platform API transport boundary — retries transient failures and propagates the last error after exhausting retries (fail-closed)
      lastError = error instanceof Error ? error : new Error(String(error));
      if ((error as RateLimitError).rateLimited) throw error;

      if (attempt < maxRetries) {
        const delayMs = boundedRetryWaitMs(
          baseDelayMs * 2 ** attempt,
          platform,
          deadlineAt,
          minimumAttemptBudgetMs,
        );
        logger.warn(`[${platform}] Request failed, retrying in ${delayMs}ms: ${lastError.message}`);
        await sleep(delayMs, signal);
      }
    }
  }

  throw lastError || new Error(`${platform} request failed after ${maxRetries} retries`);
}

export function getRateLimitConfig(platform: SocialPlatform) {
  return PLATFORM_RATE_LIMITS[platform];
}

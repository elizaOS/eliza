import type { SocialPlatform } from "@/lib/types/social-media";
import { logger } from "@/lib/utils/logger";

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const { maxRetries = 3, baseDelayMs = 1000, platform } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fn();

      if (isRateLimitResponse(response)) {
        const retryAfter = parseRetryAfter(response);
        const waitMs = retryAfter || baseDelayMs * 2 ** attempt;

        if (attempt < maxRetries) {
          logger.warn(
            `[${platform}] Rate limited, waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`,
          );
          await sleep(waitMs);
          continue;
        }
        throw createRateLimitError(platform, retryAfter ? retryAfter / 1000 : undefined);
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(`${platform} API error ${response.status}: ${errorBody}`);
      }

      return { data: await parser(response) };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if ((error as RateLimitError).rateLimited) throw error;

      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * 2 ** attempt;
        logger.warn(`[${platform}] Request failed, retrying in ${delayMs}ms: ${lastError.message}`);
        await sleep(delayMs);
      }
    }
  }

  throw lastError || new Error(`${platform} request failed after ${maxRetries} retries`);
}

export function getRateLimitConfig(platform: SocialPlatform) {
  return PLATFORM_RATE_LIMITS[platform];
}

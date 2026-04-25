/**
 * Sensitive-route rate limiter.
 *
 * The existing `authAttempts` bucket in `../auth.ts` covers token-auth
 * failures (20/min/ip). Sensitive auth writes — bootstrap exchange,
 * password change, machine-token rotation — get a stricter bucket sized
 * 5/min/ip, separate so a normal auth-failure burst doesn't lock out
 * legitimate sensitive writes.
 *
 * Caller pattern:
 *
 *   if (!sensitiveRateLimit.consume(ip)) {
 *     sendJsonError(res, 429, "Too many requests");
 *     return true;
 *   }
 */

export const SENSITIVE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const SENSITIVE_RATE_LIMIT_MAX = 5;

interface BucketEntry {
  count: number;
  resetAt: number;
}

class SensitiveRateLimiter {
  private readonly buckets = new Map<string, BucketEntry>();

  /**
   * Returns true when the request is allowed, false when the limit is
   * exhausted. Each successful call increments the bucket, so repeated
   * `consume` calls in the same window will eventually return false even
   * for valid traffic — this is intentional.
   */
  consume(ip: string | null, now: number = Date.now()): boolean {
    const key = ip ?? "unknown";
    const entry = this.buckets.get(key);
    if (!entry || now > entry.resetAt) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + SENSITIVE_RATE_LIMIT_WINDOW_MS,
      });
      return true;
    }
    if (entry.count >= SENSITIVE_RATE_LIMIT_MAX) return false;
    entry.count += 1;
    return true;
  }

  reset(): void {
    this.buckets.clear();
  }

  sweep(now: number = Date.now()): void {
    for (const [key, entry] of this.buckets) {
      if (now > entry.resetAt) this.buckets.delete(key);
    }
  }
}

export const bootstrapExchangeLimiter = new SensitiveRateLimiter();

const sweepTimer = setInterval(
  () => {
    bootstrapExchangeLimiter.sweep();
  },
  5 * 60 * 1000,
);
if (typeof sweepTimer === "object" && "unref" in sweepTimer) {
  sweepTimer.unref();
}

/** Reset state. Test-only. */
export function _resetSensitiveLimiters(): void {
  bootstrapExchangeLimiter.reset();
}

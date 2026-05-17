/**
 * Sensitive-route rate limiter.
 *
 * The existing `authAttempts` bucket in `../auth.ts` covers token-auth
 * failures (20/min/ip). Sensitive auth writes — bootstrap exchange,
 * password change, machine-token rotation, owner-binding state changes,
 * SSO callback exchanges — get a stricter bucket sized 5/min/ip, separate
 * so a normal auth-failure burst doesn't lock out legitimate sensitive
 * writes.
 *
 * Each named route gets its own bucket via `getSensitiveLimiter(name)` so
 * a flood on `/api/auth/login/sso/start` does not lock out
 * `/api/auth/owner/bind/start` for the same client. Buckets are created
 * lazily and tracked centrally so the singleton sweep + reset hooks cover
 * all of them.
 *
 * Caller pattern:
 *
 *   const limiter = getSensitiveLimiter("auth.bootstrap.exchange");
 *   if (!limiter.consume(ip)) {
 *     sendJsonError(res, 429, "Too many requests");
 *     return true;
 *   }
 */
export declare const SENSITIVE_RATE_LIMIT_WINDOW_MS: number;
export declare const SENSITIVE_RATE_LIMIT_MAX = 5;
declare class SensitiveRateLimiter {
    private readonly buckets;
    /**
     * Returns true when the request is allowed, false when the limit is
     * exhausted. Each successful call increments the bucket, so repeated
     * `consume` calls in the same window will eventually return false even
     * for valid traffic — this is intentional.
     */
    consume(ip: string | null, now?: number): boolean;
    reset(): void;
    sweep(now?: number): void;
}
/**
 * Look up (or lazily create) the named sensitive-route limiter. Use one
 * name per logical operation — e.g. `auth.bootstrap.exchange`,
 * `auth.login.sso.start`, `auth.owner.bind.start`.
 *
 * Buckets are kept in a central registry so the sweep timer and the
 * `_resetSensitiveLimiters` test helper handle them all.
 */
export declare function getSensitiveLimiter(name: string): SensitiveRateLimiter;
/** Bootstrap exchange limiter. New code should prefer `getSensitiveLimiter(name)`. */
export declare const bootstrapExchangeLimiter: SensitiveRateLimiter;
/** Reset state. Test-only. */
export declare function _resetSensitiveLimiters(): void;
export {};
//# sourceMappingURL=sensitive-rate-limit.d.ts.map
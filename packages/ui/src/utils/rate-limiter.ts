/**
 * Generic in-memory rate limiter with automatic sweep.
 *
 * Consolidates the per-IP rate limiting pattern from
 * `@elizaos/plugin-wallet/lib/wallet-export-guard` and the pairing attempt
 * limiter in `server.ts`.
 */

export interface RateLimiterOptions {
  /** Time window in milliseconds. An action is blocked if the last allowed
   *  action for the same key happened less than `windowMs` ago. */
  windowMs: number;
  /** How often (ms) to sweep stale entries. Defaults to `windowMs * 1.5`. */
  sweepIntervalMs?: number;
}

export interface RateLimitCheck {
  /** `true` if the action is allowed. */
  allowed: boolean;
  /** Seconds until the action would be allowed again (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Check *and* record an action for `key`. */
  check(key: string): RateLimitCheck;
  /** Peek without recording — returns the same shape but doesn't consume. */
  peek(key: string): RateLimitCheck;
  /** Remove all tracked keys. */
  clear(): void;
  /** Stop the background sweep timer (for clean shutdown / tests). */
  dispose(): void;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { windowMs } = opts;
  const sweepIntervalMs = opts.sweepIntervalMs ?? Math.ceil(windowMs * 1.5);
  const map = new Map<string, number>(); // key → lastActionAt

  const sweepTimer = setInterval(() => {
    const cutoff = Date.now() - windowMs * 2;
    for (const [key, ts] of map) {
      if (ts < cutoff) map.delete(key);
    }
  }, sweepIntervalMs);

  // Allow the process to exit without this timer holding it
  if (typeof sweepTimer === "object" && "unref" in sweepTimer) {
    (sweepTimer as NodeJS.Timeout).unref();
  }

  function peekImpl(key: string): RateLimitCheck {
    const last = map.get(key);
    if (last === undefined) return { allowed: true, retryAfterSeconds: 0 };
    const elapsed = Date.now() - last;
    if (elapsed >= windowMs) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((windowMs - elapsed) / 1000),
    };
  }

  return {
    check(key: string): RateLimitCheck {
      const result = peekImpl(key);
      if (result.allowed) {
        map.set(key, Date.now());
      }
      return result;
    },
    peek: peekImpl,
    clear() {
      map.clear();
    },
    dispose() {
      clearInterval(sweepTimer);
      map.clear();
    },
  };
}

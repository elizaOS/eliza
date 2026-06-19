/**
 * `RateLimitGovernor` — a deterministic, clock-injected throttle for the
 * DigitalOcean v2 REST API droplet-create path, plus `pollAction`, the
 * WaitForActive poll loop the async provider primitive is built on.
 *
 * ## Why this exists
 *
 * The DO API enforces three independent limits the control plane can trip
 * during a burst of droplet provisioning:
 *
 *   - **≤ 250 requests / minute** (account-wide rolling window)
 *   - **≤ 5000 requests / hour** (account-wide rolling window)
 *   - **≤ 10 concurrent droplet creates** in flight
 *
 * The first two are *rates* — capacity returns as time passes. The third is a
 * *semaphore* — capacity returns only when an in-flight create finishes. They
 * are modelled differently on purpose: rates are lazy-refill token buckets;
 * concurrency is an explicit waiter queue woken by `release()`.
 *
 * The governor makes **no HTTP calls itself**. The caller drives it: `acquire()`
 * before starting a create, `release()` when the create settles, and
 * `observeHeaders()` / `note429()` after each response so the governor can
 * self-correct against the server's own `ratelimit-remaining` / `ratelimit-reset`
 * headers (the server is the source of truth — local buckets drift because the
 * account-wide budget is also consumed by calls that never went through this
 * governor).
 *
 * ## Determinism
 *
 * Every wait routes through an injected {@link Clock} (`now()` + `sleep()`); the
 * logic path contains no `Date.now`, no real `setTimeout`, and no `Math.random`.
 * Backoff is a pure `base * 2^attempt` schedule (no jitter) so a `ManualClock`
 * in the test reproduces every timing exactly.
 */

import type { ComputeAction } from "./compute-provider.js";

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/**
 * The injected time source. `now()` returns monotonic-ish milliseconds (only
 * deltas matter); `sleep(ms)` resolves after `ms` virtual milliseconds. The
 * production default uses `Date.now` and `setTimeout`; tests pass a
 * `ManualClock` that advances virtual time explicitly.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Production clock: wall time + real timers. Never used in tests. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    }),
};

// ---------------------------------------------------------------------------
// Token bucket (lazy refill, no background timer)
// ---------------------------------------------------------------------------

/**
 * A lazy-refill token bucket. No background timer: capacity is reconstructed on
 * demand from elapsed time, so it is fully deterministic under an injected
 * clock. `refillPerMs` is `capacity / windowMs` — the steady-state rate that
 * refills a full bucket over one window.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    readonly capacity: number,
    private readonly refillPerMs: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = now;
  }

  private refill(now: number): void {
    if (now <= this.lastRefill) {
      // Clock did not advance (or went backwards): never add tokens, but do
      // not let `lastRefill` run ahead of `now`.
      this.lastRefill = Math.min(this.lastRefill, now);
      return;
    }
    const gained = (now - this.lastRefill) * this.refillPerMs;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.lastRefill = now;
  }

  /** Current token count after refilling to `now`. */
  available(now: number): number {
    this.refill(now);
    return this.tokens;
  }

  /** Consume one token. Caller must have confirmed availability first. */
  take(now: number): void {
    this.refill(now);
    this.tokens -= 1;
  }

  /**
   * Milliseconds until at least one token is available. `0` when a token is
   * ready now. `Infinity` only if the bucket never refills (`refillPerMs <= 0`).
   */
  msUntilToken(now: number): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    if (this.refillPerMs <= 0) return Number.POSITIVE_INFINITY;
    const deficit = 1 - this.tokens;
    return Math.ceil(deficit / this.refillPerMs);
  }

  /**
   * Clamp the local token count *down* to a server-reported remaining count.
   * Never raises the local estimate above what it already believes — the server
   * is authoritative for the floor, not the ceiling (the account-wide budget is
   * shared with traffic that never passed through this governor).
   */
  clampDownTo(remaining: number, now: number): void {
    this.refill(now);
    if (remaining < this.tokens) {
      this.tokens = Math.max(0, remaining);
    }
  }
}

// ---------------------------------------------------------------------------
// Governor config
// ---------------------------------------------------------------------------

export interface RateGovernorLimits {
  /** Max requests per minute (DO default 250). */
  perMinute: number;
  /** Max requests per hour (DO default 5000). */
  perHour: number;
  /** Max concurrent droplet creates in flight (DO default 10). */
  maxConcurrentCreates: number;
  /** Base backoff for the first 429 retry, in ms (doubles per attempt). */
  backoffBaseMs: number;
  /** Cap on a single backoff delay, in ms. */
  backoffMaxMs: number;
}

export const DEFAULT_RATE_GOVERNOR_LIMITS: RateGovernorLimits = {
  perMinute: 250,
  perHour: 5000,
  maxConcurrentCreates: 10,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
};

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// RateLimitGovernor
// ---------------------------------------------------------------------------

/**
 * Token-bucket + semaphore governor for the DO droplet-create path.
 *
 * Call order per create:
 *   1. `await acquire()` — blocks until both rate budgets and a concurrency
 *      slot are free (and any 429 backoff has elapsed); consumes one rate token
 *      from each bucket and one concurrency slot.
 *   2. perform the HTTP create, then `observeHeaders(headers)` (self-correct)
 *      or `note429(headers)` (arm backoff) from the response.
 *   3. `release()` when the create settles — frees the concurrency slot and
 *      wakes the next waiter.
 */
export class RateLimitGovernor {
  private readonly minuteBucket: TokenBucket;
  private readonly hourBucket: TokenBucket;

  private inFlight = 0;
  /** FIFO queue of waiters parked on a full concurrency semaphore. */
  private readonly slotWaiters: Array<() => void> = [];

  /** Count of consecutive 429s observed (drives exponential backoff). */
  private backoffAttempt = 0;
  /** Absolute clock time before which `acquire()` must not proceed. */
  private backoffUntil = 0;

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly limits: RateGovernorLimits = DEFAULT_RATE_GOVERNOR_LIMITS,
  ) {
    const now = clock.now();
    this.minuteBucket = new TokenBucket(limits.perMinute, limits.perMinute / MS_PER_MINUTE, now);
    this.hourBucket = new TokenBucket(limits.perHour, limits.perHour / MS_PER_HOUR, now);
  }

  /** Current number of in-flight creates (creates that acquired but not released). */
  get concurrency(): number {
    return this.inFlight;
  }

  /**
   * Block until it is safe to start one droplet create, then consume one token
   * from each rate bucket and one concurrency slot. Resolves only when, in a
   * single synchronous pass with no intervening `await`:
   *   - any armed 429 backoff window has elapsed, AND
   *   - both rate buckets have ≥ 1 token, AND
   *   - a concurrency slot is free.
   *
   * Each gate that is not yet satisfiable issues exactly one wait (an injected
   * `sleep` for backoff/rate; an event-driven park woken by `release()` for the
   * semaphore) and then **re-validates every gate from the top**. This re-check
   * after each wait is what closes the TOCTOU window: two waiters that both
   * passed the rate gate and then parked on the semaphore cannot both commit a
   * `take()` and drive a bucket negative — whichever wakes second re-runs the
   * rate gate and waits again if the first already consumed the last token. The
   * commit (steps that mutate buckets + `inFlight`) runs only once all three
   * gates pass together, with no `await` between the final rate check and the
   * `take()`, so no concurrent `acquire()` can interleave between them.
   */
  async acquire(): Promise<void> {
    for (;;) {
      // 1. 429 backoff window.
      const backoffWait = this.backoffUntil - this.clock.now();
      if (backoffWait > 0) {
        await this.clock.sleep(backoffWait);
        continue;
      }

      // 2. Rate budget in both buckets.
      const now = this.clock.now();
      const rateWait = Math.max(
        this.minuteBucket.msUntilToken(now),
        this.hourBucket.msUntilToken(now),
      );
      if (rateWait > 0) {
        await this.clock.sleep(rateWait);
        continue;
      }

      // 3. Concurrency slot (semaphore; woken by release()). On wake, loop back
      //    to re-validate backoff + rate before committing.
      if (this.inFlight >= this.limits.maxConcurrentCreates) {
        await new Promise<void>((resolve) => {
          this.slotWaiters.push(resolve);
        });
        continue;
      }

      // 4. Commit. All three gates passed in this pass; no `await` since the
      //    rate check above, so the take is atomic w.r.t. other acquirers.
      this.minuteBucket.take(now);
      this.hourBucket.take(now);
      this.inFlight += 1;
      return;
    }
  }

  /**
   * Release one concurrency slot after a create settles, waking the oldest
   * parked waiter (if any). Idempotency is the caller's responsibility: each
   * `release()` must pair with exactly one successful `acquire()`.
   */
  release(): void {
    if (this.inFlight > 0) {
      this.inFlight -= 1;
    }
    const next = this.slotWaiters.shift();
    if (next) next();
  }

  /**
   * Self-correct local rate buckets from a successful response's headers.
   * Clamps each bucket *down* to the server's `ratelimit-remaining`, and clears
   * any 429 backoff (a clean observation means the server is serving us again).
   *
   * `ratelimit-remaining` is account-wide; we apply it to both buckets as a
   * conservative floor (the true per-window remaining is whichever is smaller,
   * and clamping a bucket below its own window's budget only makes us politer).
   */
  observeHeaders(headers: RateLimitHeaders): void {
    const remaining = parseHeaderInt(headers, "ratelimit-remaining");
    if (remaining !== null) {
      const now = this.clock.now();
      this.minuteBucket.clampDownTo(remaining, now);
      this.hourBucket.clampDownTo(remaining, now);
    }
    // A clean (non-429) observation resets the backoff ladder.
    this.backoffAttempt = 0;
    this.backoffUntil = 0;
  }

  /**
   * Arm exponential backoff after a 429. The next `acquire()` will not proceed
   * until the backoff window elapses. The window is the larger of:
   *   - the deterministic `base * 2^attempt` schedule (capped), and
   *   - the time until the server's `ratelimit-reset` (absolute Unix epoch
   *     *seconds*), when that header is present.
   *
   * `nowEpochMs` lets the caller map the server's epoch-seconds reset onto the
   * injected clock's millisecond timeline (the two clocks are different axes);
   * default `Date.now()` is for production only and is never exercised under the
   * `ManualClock` because tests always pass `nowEpochMs` explicitly.
   */
  note429(headers?: RateLimitHeaders, nowEpochMs: number = Date.now()): void {
    const backoffMs = this.computeBackoffMs();
    this.backoffAttempt += 1;

    const clockNow = this.clock.now();
    let windowMs = backoffMs;

    if (headers) {
      const resetEpochSec = parseHeaderInt(headers, "ratelimit-reset");
      if (resetEpochSec !== null) {
        const resetInMs = resetEpochSec * 1000 - nowEpochMs;
        if (resetInMs > windowMs) windowMs = resetInMs;
      }
    }

    if (windowMs < 0) windowMs = 0;
    this.backoffUntil = clockNow + windowMs;
  }

  /** Deterministic `base * 2^attempt`, capped at `backoffMaxMs`. */
  private computeBackoffMs(): number {
    const raw = this.limits.backoffBaseMs * 2 ** this.backoffAttempt;
    return Math.min(raw, this.limits.backoffMaxMs);
  }
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/**
 * The subset of DO rate-limit response headers the governor reads. Accepts
 * either a `Headers` instance or a plain record (case-insensitive lookup is the
 * caller's job for the record form — DO emits lowercase `ratelimit-*`).
 */
export type RateLimitHeaders = Headers | Record<string, string | undefined>;

function parseHeaderInt(headers: RateLimitHeaders, name: string): number | null {
  const raw =
    headers instanceof Headers ? headers.get(name) : (headers[name] ?? headers[name.toLowerCase()]);
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// pollAction — WaitForActive
// ---------------------------------------------------------------------------

export interface PollActionOptions {
  /** Total budget before giving up. */
  timeoutMs: number;
  /** Delay between polls. */
  intervalMs: number;
}

export const DEFAULT_POLL_ACTION_OPTIONS: PollActionOptions = {
  timeoutMs: 300_000,
  intervalMs: 5_000,
};

/**
 * DO action terminal states. Unlike Hetzner (terminal = anything other than
 * `running`), DO actions go `in-progress → completed | errored`. We treat
 * *only* these explicit strings as terminal and keep polling for anything else
 * (including `in-progress` and any unknown transient), so an in-progress action
 * is never mistaken for done.
 */
const TERMINAL_OK = "completed";
const TERMINAL_ERR = "errored";

export class PollActionError extends Error {
  constructor(
    message: string,
    readonly reason: "errored" | "timeout",
    readonly action?: ComputeAction,
  ) {
    super(message);
    this.name = "PollActionError";
  }
}

/**
 * The WaitForActive poll pattern: repeatedly fetch an action via the injected
 * `getAction` until it reaches a terminal state or the timeout elapses.
 *
 *   - `completed`  → resolve with the action.
 *   - `errored`    → throw `PollActionError(reason: "errored")`.
 *   - anything else (incl. `in-progress`) → wait `intervalMs` and re-poll.
 *   - deadline exceeded → throw `PollActionError(reason: "timeout")`.
 *
 * All waits route through `clock.sleep`; `getAction` does the I/O. The first
 * poll happens immediately (no leading sleep). The deadline is checked before
 * each fetch, and a sleep is only issued if it fits inside the remaining budget,
 * so the loop never overshoots `timeoutMs`.
 */
export async function pollAction(
  actionId: number | string,
  getAction: (id: number | string) => Promise<ComputeAction>,
  options: PollActionOptions = DEFAULT_POLL_ACTION_OPTIONS,
  clock: Clock = systemClock,
): Promise<ComputeAction> {
  const { timeoutMs, intervalMs } = options;
  const deadline = clock.now() + timeoutMs;

  for (;;) {
    const action = await getAction(actionId);

    if (action.status === TERMINAL_OK) {
      return action;
    }
    if (action.status === TERMINAL_ERR) {
      throw new PollActionError(
        `Action ${actionId} errored${action.error ? `: ${action.error.message}` : ""}`,
        "errored",
        action,
      );
    }

    // Still in progress. Stop if the next interval would breach the deadline.
    const remaining = deadline - clock.now();
    if (remaining <= 0 || intervalMs >= remaining) {
      throw new PollActionError(
        `Action ${actionId} did not reach a terminal state within ${timeoutMs}ms (last status: ${action.status})`,
        "timeout",
        action,
      );
    }
    await clock.sleep(intervalMs);
  }
}

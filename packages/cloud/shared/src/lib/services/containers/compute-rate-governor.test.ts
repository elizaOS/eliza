// Exercises compute rate governor behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import type { ComputeAction } from "./compute-provider.js";
import {
  type Clock,
  DEFAULT_RATE_GOVERNOR_LIMITS,
  PollActionError,
  pollAction,
  type RateGovernorLimits,
  RateLimitGovernor,
} from "./compute-rate-governor.js";

// ---------------------------------------------------------------------------
// ManualClock — deterministic virtual time
// ---------------------------------------------------------------------------

/**
 * A virtual clock. `now()` reads `current`; `sleep(ms)` registers a timer that
 * fires when `advance()` walks virtual time past its due point. `advance` is
 * async and awaits a microtask turn after each fire so that promise chains hung
 * off a resolved `sleep` settle before the test asserts.
 */
class ManualClock implements Clock {
  private current: number;
  private seq = 0;
  private timers: Array<{ at: number; seq: number; resolve: () => void }> = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.current + ms, seq: this.seq++, resolve });
    });
  }

  /** Number of timers still pending (sleeps not yet fired). */
  get pending(): number {
    return this.timers.length;
  }

  /**
   * Advance virtual time by `ms`, firing every timer due at or before the new
   * `current`, in (due-time, registration-order) order. Awaits a microtask turn
   * after each fire so dependent promises resolve before returning.
   */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (due.length === 0) break;
      const next = due[0]!;
      this.timers = this.timers.filter((t) => t !== next);
      this.current = next.at;
      next.resolve();
      // Let the woken continuation run (it may register a new timer).
      await Promise.resolve();
      await Promise.resolve();
    }
    this.current = target;
  }
}

/** Flush pending microtasks so awaited promises settle before assertions. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const SMALL_LIMITS: RateGovernorLimits = {
  perMinute: 3,
  perHour: 1000,
  maxConcurrentCreates: 2,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
};

// ===========================================================================
// Token-bucket rate limiting
// ===========================================================================

describe("RateLimitGovernor — rate buckets", () => {
  test("permits up to the per-minute budget without waiting", async () => {
    const clock = new ManualClock();
    const gov = new RateLimitGovernor(clock, SMALL_LIMITS);

    // Three acquires fit in the initial budget; none should park on a timer.
    await gov.acquire();
    gov.release();
    await gov.acquire();
    gov.release();
    await gov.acquire();
    gov.release();

    expect(clock.pending).toBe(0);
    expect(gov.concurrency).toBe(0);
  });

  test("the 4th acquire in a minute blocks until a token refills", async () => {
    const clock = new ManualClock();
    const gov = new RateLimitGovernor(clock, SMALL_LIMITS);

    for (let i = 0; i < 3; i++) {
      await gov.acquire();
      gov.release();
    }

    let resolved = false;
    const p = gov.acquire().then(() => {
      resolved = true;
    });
    await flush();
    // Parked: budget exhausted, waiting on the minute bucket.
    expect(resolved).toBe(false);
    expect(clock.pending).toBe(1);

    // One token refills every minute/perMinute = 60000/3 = 20000ms.
    await clock.advance(19_999);
    expect(resolved).toBe(false);

    await clock.advance(1);
    await p;
    expect(resolved).toBe(true);
    gov.release();
  });

  test("uses real DO defaults (250/min, 5000/hr, 10 concurrent)", () => {
    expect(DEFAULT_RATE_GOVERNOR_LIMITS.perMinute).toBe(250);
    expect(DEFAULT_RATE_GOVERNOR_LIMITS.perHour).toBe(5000);
    expect(DEFAULT_RATE_GOVERNOR_LIMITS.maxConcurrentCreates).toBe(10);
  });
});

// ===========================================================================
// Concurrency semaphore (event-driven, woken by release)
// ===========================================================================

describe("RateLimitGovernor — concurrency", () => {
  test("caps in-flight creates and wakes a waiter on release (not a timer)", async () => {
    const clock = new ManualClock();
    const gov = new RateLimitGovernor(clock, SMALL_LIMITS);

    await gov.acquire();
    await gov.acquire();
    expect(gov.concurrency).toBe(2);

    // Third acquire must park on the semaphore — no rate wait involved
    // (perMinute budget still has a token left after 2 takes).
    let resolved = false;
    const p = gov.acquire().then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);
    // Parked on the semaphore, NOT on a timer.
    expect(clock.pending).toBe(0);

    // Advancing time alone must NOT free the slot.
    await clock.advance(120_000);
    expect(resolved).toBe(false);

    // release() wakes it immediately.
    gov.release();
    await p;
    expect(resolved).toBe(true);
    expect(gov.concurrency).toBe(2);
  });

  test("waiters are woken in FIFO order", async () => {
    const clock = new ManualClock();
    const gov = new RateLimitGovernor(clock, {
      ...SMALL_LIMITS,
      perMinute: 100,
      maxConcurrentCreates: 1,
    });

    await gov.acquire();
    const order: number[] = [];
    const p1 = gov.acquire().then(() => order.push(1));
    const p2 = gov.acquire().then(() => order.push(2));
    await flush();
    expect(order).toEqual([]);

    gov.release();
    await p1;
    gov.release();
    await p2;
    expect(order).toEqual([1, 2]);
  });

  test("rate cap holds across the semaphore wait (TOCTOU: no over-consume)", async () => {
    const clock = new ManualClock();
    // 2 concurrent slots, only 3 rate tokens. After 2 in-flight creates the
    // minute bucket has exactly 1 token left — two further waiters must not both
    // commit a take() against that single token when both wake on release.
    const gov = new RateLimitGovernor(clock, {
      ...SMALL_LIMITS,
      perMinute: 3,
      perHour: 1_000,
      maxConcurrentCreates: 2,
    });

    await gov.acquire(); // A
    await gov.acquire(); // A2
    expect(gov.concurrency).toBe(2); // tokens: 3 - 2 = 1 left

    // B and C both pass the rate gate (1 token visible, not yet consumed),
    // then park on the full semaphore.
    let bDone = false;
    let cDone = false;
    const pB = gov.acquire().then(() => {
      bDone = true;
    });
    const pC = gov.acquire().then(() => {
      cDone = true;
    });
    await flush();
    expect(bDone).toBe(false);
    expect(cDone).toBe(false);

    // Free both slots. Both B and C wake; only ONE may consume the last rate
    // token. The other must re-validate rate, find 0 tokens, and re-park on a
    // refill timer — NOT commit and drive the bucket negative.
    gov.release(); // A done
    gov.release(); // A2 done
    await pB; // first waiter commits the last token
    expect(bDone).toBe(true);

    // C is still blocked on rate (token exhausted) — parked on a sleep timer.
    await flush();
    expect(cDone).toBe(false);
    expect(clock.pending).toBe(1);
    // Crucially, concurrency did not exceed the cap: B took the freed slot, C
    // has not.
    expect(gov.concurrency).toBe(1);

    // A token refills every 20000ms (60000/3). Advance to release C.
    await clock.advance(20_000);
    await pC;
    expect(cDone).toBe(true);
    expect(gov.concurrency).toBe(2);
    gov.release();
    gov.release();
  });
});

// ===========================================================================
// Header self-correction
// ===========================================================================

describe("RateLimitGovernor — header self-correction", () => {
  test("clamps local budget DOWN to ratelimit-remaining", async () => {
    const clock = new ManualClock();
    const gov = new RateLimitGovernor(clock, {
      ...SMALL_LIMITS,
      perMinute: 100,
      perHour: 360_000, // 100/ms refills fast enough that the minute bucket dominates
      maxConcurrentCreates: 10,
    });

    // Server says only 1 request remains account-wide (clamps BOTH buckets).
    gov.observeHeaders({ "ratelimit-remaining": "1" });

    // First acquire consumes the clamped token.
    await gov.acquire();
    gov.release();

    // Second must now block on refill despite a nominal minute budget of 100.
    let resolved = false;
    const p = gov.acquire().then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);
    expect(clock.pending).toBe(1);

    // Minute bucket: 100/60000 per ms → 1 token in 600ms (the binding wait;
    // hour bucket refills 360000/3600000 = 0.1/ms → its 1 token in 10ms).
    await clock.advance(600);
    await p;
    expect(resolved).toBe(true);
    gov.release();
  });

  test("does NOT raise local budget above its own estimate", async () => {
    const clock = new ManualClock();
    const gov = new RateLimitGovernor(clock, SMALL_LIMITS); // perMinute 3

    // Drain to 0.
    for (let i = 0; i < 3; i++) {
      await gov.acquire();
      gov.release();
    }

    // Server (lying / stale) reports a huge remaining — must be ignored upward.
    gov.observeHeaders({ "ratelimit-remaining": "9999" });

    let resolved = false;
    const p = gov.acquire().then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false); // still drained; clamp never raised us
    await clock.advance(20_000); // one token refills
    await p;
    expect(resolved).toBe(true);
    gov.release();
  });
});

// ===========================================================================
// 429 backoff
// ===========================================================================

describe("RateLimitGovernor — 429 backoff", () => {
  test("a single 429 arms base backoff before the next acquire proceeds", async () => {
    const clock = new ManualClock();
    const gov = new RateLimitGovernor(clock, {
      ...SMALL_LIMITS,
      perMinute: 100,
      perHour: 100,
    });

    gov.note429(); // attempt 0 → base * 2^0 = 1000ms

    let resolved = false;
    const p = gov.acquire().then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);

    await clock.advance(999);
    expect(resolved).toBe(false);
    await clock.advance(1);
    await p;
    expect(resolved).toBe(true);
    gov.release();
  });

  test("backoff grows exponentially across consecutive 429s", async () => {
    const clock = new ManualClock();
    const gov = new RateLimitGovernor(clock, {
      ...SMALL_LIMITS,
      perMinute: 100,
      perHour: 100,
    });

    gov.note429(); // attempt 0 → 1000ms
    gov.note429(); // attempt 1 → 2000ms
    gov.note429(); // attempt 2 → 4000ms  (this is the active window)

    let resolved = false;
    const p = gov.acquire().then(() => {
      resolved = true;
    });
    await flush();

    await clock.advance(3_999);
    expect(resolved).toBe(false);
    await clock.advance(1);
    await p;
    expect(resolved).toBe(true);
    gov.release();
  });

  test("backoff is capped at backoffMaxMs", async () => {
    const clock = new ManualClock();
    const gov = new RateLimitGovernor(clock, {
      ...SMALL_LIMITS,
      perMinute: 100,
      perHour: 100,
      backoffBaseMs: 1_000,
      backoffMaxMs: 60_000,
    });

    // attempts 0..6 → 1000·2^6 = 64000ms uncapped; the active window is the
    // capped 60000ms, not 64000.
    for (let i = 0; i < 7; i++) gov.note429();

    let resolved = false;
    const p = gov.acquire().then(() => {
      resolved = true;
    });
    await flush();

    await clock.advance(59_999);
    expect(resolved).toBe(false);
    await clock.advance(1); // exactly at the cap → proceeds
    await p;
    expect(resolved).toBe(true);
    gov.release();
  });

  test("a clean observation resets the backoff ladder", async () => {
    const clock = new ManualClock();
    const gov = new RateLimitGovernor(clock, {
      ...SMALL_LIMITS,
      perMinute: 100,
      perHour: 100,
    });

    gov.note429();
    gov.note429(); // attempt now 2

    // Clean response: clears backoff AND resets the attempt counter.
    gov.observeHeaders({ "ratelimit-remaining": "50" });

    // acquire proceeds immediately (no backoff window).
    await gov.acquire();
    gov.release();
    expect(clock.pending).toBe(0);

    // Next 429 starts back at base (1000ms), proving the counter reset.
    gov.note429();
    let resolved = false;
    const p = gov.acquire().then(() => {
      resolved = true;
    });
    await flush();
    await clock.advance(1_000);
    await p;
    expect(resolved).toBe(true);
    gov.release();
  });

  test("backoff honors ratelimit-reset (epoch seconds) when it exceeds the schedule", async () => {
    const clock = new ManualClock(0);
    const gov = new RateLimitGovernor(clock, {
      ...SMALL_LIMITS,
      perMinute: 100,
      perHour: 100,
    });

    // Server: reset 30s from now. nowEpochMs=1_000_000 → reset at 1_030_000.
    // Schedule would be 1000ms; the 30s reset wins.
    gov.note429({ "ratelimit-reset": "1030" }, 1_000_000);

    let resolved = false;
    const p = gov.acquire().then(() => {
      resolved = true;
    });
    await flush();

    await clock.advance(29_999);
    expect(resolved).toBe(false);
    await clock.advance(1);
    await p;
    expect(resolved).toBe(true);
    gov.release();
  });
});

// ===========================================================================
// pollAction — WaitForActive
// ===========================================================================

function action(status: string, extra: Partial<ComputeAction> = {}): ComputeAction {
  return { id: 1, status, ...extra };
}

describe("pollAction", () => {
  test("resolves immediately when the action is already completed (no sleep)", async () => {
    const clock = new ManualClock();
    const result = await pollAction(
      1,
      async () => action("completed"),
      { timeoutMs: 300_000, intervalMs: 5_000 },
      clock,
    );
    expect(result.status).toBe("completed");
    expect(clock.pending).toBe(0);
  });

  test("spec signature: (actionId, getAction, {timeoutMs, intervalMs}) with clock defaulted", async () => {
    // A spec-conformant caller passes the options object as the 3rd arg and
    // omits the clock; an already-terminal action resolves with no real sleep.
    const result = await pollAction(42, async () => action("completed"), {
      timeoutMs: 300_000,
      intervalMs: 5_000,
    });
    expect(result.status).toBe("completed");
  });

  test("polls through in-progress until completed", async () => {
    const clock = new ManualClock();
    const statuses = ["in-progress", "in-progress", "completed"];
    let i = 0;
    const getAction = async () => action(statuses[i++]!);

    const p = pollAction(1, getAction, { timeoutMs: 300_000, intervalMs: 5_000 }, clock);

    // First poll → in-progress, sleeps 5000.
    await flush();
    expect(i).toBe(1);
    await clock.advance(5_000); // → second poll (in-progress), sleeps again
    expect(i).toBe(2);
    await clock.advance(5_000); // → third poll (completed), resolves
    const result = await p;
    expect(result.status).toBe("completed");
    expect(i).toBe(3);
  });

  test("does NOT treat in-progress as terminal (the Hetzner-negation trap)", async () => {
    const clock = new ManualClock();
    let calls = 0;
    const getAction = async () => {
      calls++;
      return action("in-progress");
    };

    const p = pollAction(1, getAction, { timeoutMs: 12_000, intervalMs: 5_000 }, clock).catch(
      (e) => e,
    );

    await flush();
    expect(calls).toBe(1); // polled, not returned
    await clock.advance(5_000);
    expect(calls).toBe(2);
    await clock.advance(5_000);
    // Now remaining = 2000 < intervalMs (5000) → timeout without a 3rd sleep.
    const err = await p;
    expect(err).toBeInstanceOf(PollActionError);
    expect((err as PollActionError).reason).toBe("timeout");
  });

  test("throws PollActionError(reason: errored) on an errored action", async () => {
    const clock = new ManualClock();
    const getAction = async () =>
      action("errored", { error: { code: "boom", message: "droplet failed" } });

    let caught: unknown;
    try {
      await pollAction(1, getAction, { timeoutMs: 300_000, intervalMs: 5_000 }, clock);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PollActionError);
    expect((caught as PollActionError).reason).toBe("errored");
    expect((caught as PollActionError).message).toContain("droplet failed");
  });

  test("throws PollActionError(reason: timeout) when never terminal", async () => {
    const clock = new ManualClock();
    const getAction = async () => action("in-progress");

    const p = pollAction(1, getAction, { timeoutMs: 10_000, intervalMs: 5_000 }, clock).catch(
      (e) => e,
    );
    await flush();
    await clock.advance(5_000);
    await clock.advance(5_000);
    const err = await p;
    expect(err).toBeInstanceOf(PollActionError);
    expect((err as PollActionError).reason).toBe("timeout");
  });

  test("never overshoots timeoutMs (no sleep that breaches the deadline)", async () => {
    const clock = new ManualClock();
    const getAction = async () => action("in-progress");

    // timeoutMs not a multiple of intervalMs: 7000 budget, 5000 interval.
    const p = pollAction(1, getAction, { timeoutMs: 7_000, intervalMs: 5_000 }, clock).catch(
      (e) => e,
    );
    await flush();
    // After the first poll, remaining=7000 >= 5000 so it sleeps once.
    await clock.advance(5_000);
    // remaining now 2000 < 5000 → must timeout WITHOUT sleeping past 7000.
    const err = await p;
    expect(err).toBeInstanceOf(PollActionError);
    expect((err as PollActionError).reason).toBe("timeout");
    // Virtual time never advanced past the budget via an in-loop sleep.
    expect(clock.now()).toBe(5_000);
    expect(clock.pending).toBe(0);
  });
});

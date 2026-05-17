/**
 * FakeClock — deterministic virtual time for InterruptBench.
 *
 * Real wall-clock is unreliable for benchmarking interruption ordering — we
 * want a script `{ t: 0 }`, `{ t: 800 }`, `{ t: 1600 }` to fire at those
 * exact virtual offsets regardless of host load.
 *
 * Two modes:
 *   - `advance(ms)` — single-step manual advance, used by the scripted runner.
 *   - `runUntil(ms)` — auto-fires any registered timers up to `ms`.
 *
 * The clock is *not* a substitute for `setTimeout` everywhere — it's used by
 * the channel simulator to dispatch script steps in order. The runtime under
 * test still uses real promises; the clock only controls the simulator's
 * dispatch loop.
 */

interface ScheduledFn {
  at: number;
  fn: () => Promise<void> | void;
  id: number;
}

export class FakeClock {
  private nowMs = 0;
  private nextId = 1;
  private queue: ScheduledFn[] = [];

  now(): number {
    return this.nowMs;
  }

  scheduleAt(at: number, fn: () => Promise<void> | void): number {
    const id = this.nextId++;
    this.queue.push({ at, fn, id });
    this.queue.sort((a, b) => a.at - b.at);
    return id;
  }

  cancel(id: number): void {
    this.queue = this.queue.filter((s) => s.id !== id);
  }

  /**
   * Advance to the given virtual time, firing every registered fn whose `at`
   * is <= the target. Awaits each fn in order before advancing time.
   */
  async runUntil(targetMs: number): Promise<void> {
    while (this.queue.length > 0 && this.queue[0]?.at <= targetMs) {
      const next = this.queue.shift()!;
      this.nowMs = next.at;
      await next.fn();
    }
    if (this.nowMs < targetMs) {
      this.nowMs = targetMs;
    }
  }

  pending(): number {
    return this.queue.length;
  }
}

/**
 * Supplies an explicitly advanced clock and timer seam so production workers
 * can run schedules, retries, expiries, and notifications without wall time.
 */
export interface ClockAdapter {
  now(): Date;
  setTimeout(callback: () => void | Promise<void>, delayMs: number): string;
  clearTimeout(timerId: string): void;
  setInterval(callback: () => void | Promise<void>, intervalMs: number): string;
  clearInterval(timerId: string): void;
  sleep(delayMs: number): Promise<void>;
}

interface ScheduledTimer {
  id: string;
  dueMs: number;
  callback: () => void | Promise<void>;
  intervalMs?: number;
}

export class VirtualClock {
  private currentMs: number;
  private sequence = 0;
  private readonly timers = new Map<string, ScheduledTimer>();
  public readonly timezone: string;

  public readonly adapter: ClockAdapter = {
    now: () => this.now(),
    setTimeout: (callback, delayMs) => this.setTimeout(callback, delayMs),
    clearTimeout: (timerId) => this.clearTimeout(timerId),
    setInterval: (callback, intervalMs) =>
      this.setInterval(callback, intervalMs),
    clearInterval: (timerId) => this.clearTimeout(timerId),
    sleep: (delayMs) => this.sleep(delayMs),
  };

  public constructor(epoch: string | Date, timezone = "UTC") {
    this.currentMs = new Date(epoch).getTime();
    if (!Number.isFinite(this.currentMs))
      throw new RangeError("VirtualClock epoch must be a valid timestamp");
    this.timezone = timezone;
  }

  public now(): Date {
    return new Date(this.currentMs);
  }

  public nowIso(): string {
    return this.now().toISOString();
  }

  public setTimeout(
    callback: () => void | Promise<void>,
    delayMs: number,
  ): string {
    return this.schedule(callback, delayMs);
  }

  public setInterval(
    callback: () => void | Promise<void>,
    intervalMs: number,
  ): string {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0)
      throw new RangeError("Virtual interval must be positive");
    return this.schedule(callback, intervalMs, intervalMs);
  }

  public clearTimeout(timerId: string): void {
    this.timers.delete(timerId);
  }

  public sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeout(resolve, delayMs);
    });
  }

  public async advanceBy(durationMs: number): Promise<number> {
    if (!Number.isFinite(durationMs) || durationMs < 0)
      throw new RangeError("Virtual duration must be non-negative");
    return this.advanceTo(new Date(this.currentMs + durationMs));
  }

  public async advanceTo(target: string | Date): Promise<number> {
    const targetMs = new Date(target).getTime();
    if (!Number.isFinite(targetMs) || targetMs < this.currentMs) {
      throw new RangeError("Virtual time cannot move backwards");
    }
    let executed = 0;
    while (true) {
      const next = this.nextDueTimer(targetMs);
      if (!next) break;
      this.currentMs = next.dueMs;
      if (next.intervalMs === undefined) this.timers.delete(next.id);
      else next.dueMs += next.intervalMs;
      await next.callback();
      executed += 1;
      if (executed > 100_000)
        throw new Error("VirtualClock advance exceeded 100000 timer callbacks");
    }
    this.currentMs = targetMs;
    return executed;
  }

  public async runUntilIdle(maxCallbacks = 10_000): Promise<number> {
    let executed = 0;
    while (this.timers.size > 0) {
      const nextDueMs = Math.min(
        ...[...this.timers.values()].map((timer) => timer.dueMs),
      );
      executed += await this.advanceTo(new Date(nextDueMs));
      if (executed >= maxCallbacks)
        throw new Error(
          `VirtualClock did not become idle within ${maxCallbacks} callbacks`,
        );
    }
    return executed;
  }

  public async step(): Promise<boolean> {
    const next = this.nextDueTimer(Number.POSITIVE_INFINITY);
    if (!next) return false;
    await this.advanceTo(new Date(next.dueMs));
    return true;
  }

  public reset(epoch: string | Date): void {
    const epochMs = new Date(epoch).getTime();
    if (!Number.isFinite(epochMs))
      throw new RangeError("VirtualClock epoch must be a valid timestamp");
    this.timers.clear();
    this.sequence = 0;
    this.currentMs = epochMs;
  }

  public get pendingTimerCount(): number {
    return this.timers.size;
  }

  private schedule(
    callback: () => void | Promise<void>,
    delayMs: number,
    intervalMs?: number,
  ): string {
    if (!Number.isFinite(delayMs) || delayMs < 0)
      throw new RangeError("Virtual timer delay must be non-negative");
    const id = `timer-${++this.sequence}`;
    this.timers.set(id, {
      id,
      dueMs: this.currentMs + delayMs,
      callback,
      intervalMs,
    });
    return id;
  }

  private nextDueTimer(targetMs: number): ScheduledTimer | undefined {
    return [...this.timers.values()]
      .filter((timer) => timer.dueMs <= targetMs)
      .sort(
        (left, right) =>
          left.dueMs - right.dueMs || left.id.localeCompare(right.id),
      )[0];
  }
}

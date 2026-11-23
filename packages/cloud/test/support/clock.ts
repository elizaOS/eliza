// spec/cloud/shared/metering.md, "Story: Settle every call once"
import { Clock, Effect } from "effect";

export interface ShiftedClock {
  readonly clock: Clock.Clock;
  advance(milliseconds: number): void;
}

export function shiftedClock(): ShiftedClock {
  let offset = 0;
  const live = Effect.runSync(Clock.Clock);
  const nanos = () => BigInt(Date.now() + offset) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => Date.now() + offset,
    currentTimeMillis: Effect.sync(() => Date.now() + offset),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => process.hrtime.bigint(),
    monotonicTimeNanos: Effect.sync(() => process.hrtime.bigint()),
    sleep: (duration) => live.sleep(duration),
  };
  return { clock, advance: (milliseconds) => { offset += milliseconds; } };
}

export interface ManualClock {
  readonly clock: Clock.Clock;
  set(milliseconds: number): void;
}

export function manualClock(): ManualClock {
  let now = 0;
  const nanos = () => BigInt(now) * 1_000_000n;
  const { clock: shifted } = shiftedClock();
  const clock: Clock.Clock = {
    ...shifted,
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
  };
  return { clock, set: (milliseconds) => { now = milliseconds; } };
}

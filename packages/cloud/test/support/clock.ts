// spec/cloud/shared/metering.md, "Story: Never overdraw an account, and settle every call once"
import { Clock, Duration, Effect } from "effect";

export interface ShiftedClock {
  readonly clock: Clock.Clock;
  advance(milliseconds: number): void;
}

export function shiftedClock(): ShiftedClock {
  let offset = 0;
  const nanos = () => BigInt(Date.now() + offset) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => Date.now() + offset,
    currentTimeMillis: Effect.sync(() => Date.now() + offset),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => process.hrtime.bigint(),
    monotonicTimeNanos: Effect.sync(() => process.hrtime.bigint()),
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
        return Effect.sync(() => clearTimeout(timer));
      }),
  };
  return { clock, advance: (milliseconds) => { offset += milliseconds; } };
}

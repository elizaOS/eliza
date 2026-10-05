/**
 * pollAction deadline-boundary regression.
 *
 * Pins that the WaitForActive loop uses the full timeout budget: a sleep
 * that lands exactly on the deadline is allowed, so an action that reaches
 * a terminal state on the final poll resolves instead of throwing a
 * spurious timeout. A genuinely stuck action must still throw
 * PollActionError with reason "timeout".
 *
 * Pure manual-clock cases; no DB, network, or credentials needed.
 */

import { describe, expect, test } from "bun:test";

import {
  PollActionError,
  pollAction,
} from "../compute-rate-governor";

function makeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

describe("pollAction deadline boundary", () => {
  test("completion on the poll landing exactly on the deadline resolves", async () => {
    const clock = makeClock();
    let calls = 0;
    const result = await pollAction(
      1,
      async () => (++calls === 1 ? { status: "in-progress" } : { status: "completed" }),
      { timeoutMs: 5000, intervalMs: 5000 },
      clock,
    );
    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
    expect(clock.now()).toBe(5000);
  });

  test("a stuck action still throws PollActionError with reason timeout", async () => {
    const clock = makeClock();
    let calls = 0;
    const failure = await pollAction(
      2,
      async () => {
        calls++;
        return { status: "in-progress" };
      },
      { timeoutMs: 5000, intervalMs: 5000 },
      clock,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PollActionError);
    expect((failure as PollActionError).reason).toBe("timeout");
    expect(calls).toBe(2);
  });

  test("default 300s/5s budget runs its final poll instead of giving up early", async () => {
    const clock = makeClock();
    let calls = 0;
    const result = await pollAction(
      3,
      async () => (++calls < 61 ? { status: "in-progress" } : { status: "completed" }),
      { timeoutMs: 300_000, intervalMs: 5_000 },
      clock,
    );
    expect(result.status).toBe("completed");
    expect(calls).toBe(61);
    expect(clock.now()).toBe(300_000);
  });
});

import type { PendantInsights } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InsightsClient,
  InsightsClientResult,
  RequestInsightsInput,
} from "./insights-client";
import { PendantInsightsScheduler } from "./insights-scheduler";

function insights(summary = "summary"): PendantInsights {
  return {
    schemaVersion: 1,
    summary,
    actionItems: [],
    topics: [],
    peopleMentioned: [],
    notableQuotes: [],
    generatedAt: 1,
    transcriptRange: {
      startOrdinal: 0,
      endOrdinal: 2,
      segmentCount: 3,
      startedAtMs: 0,
      endedAtMs: 0,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PendantInsightsScheduler privacy and cost controls", () => {
  it("retains and uploads nothing before opt-in or while paused", async () => {
    const requestInsights = vi.fn(
      async (): Promise<InsightsClientResult> => ({
        ok: true,
        insights: insights(),
      }),
    );
    const scheduler = new PendantInsightsScheduler({
      client: { requestInsights },
      onInsights: vi.fn(),
      minSegments: 3,
      minIntervalMs: 0,
    });

    scheduler.addUtterance("before opt in");
    expect(scheduler.getWindow()).toEqual([]);
    scheduler.setEnabled(true);
    scheduler.setPaused(true);
    scheduler.addUtterance("while paused");
    expect(scheduler.getWindow()).toEqual([]);
    await scheduler.flush();
    expect(requestInsights).not.toHaveBeenCalled();
  });

  it("dedupes normalized repeats and bounds the rolling window", () => {
    const scheduler = new PendantInsightsScheduler({
      client: {
        requestInsights: vi.fn(async () => ({
          ok: false as const,
          skipped: true as const,
          reason: "too-few-segments",
        })),
      },
      onInsights: vi.fn(),
      minSegments: 3,
      maxWindowSegments: 3,
      sessionId: "stable",
    });
    scheduler.setEnabled(true);
    const first = scheduler.addUtterance("Hello   there.");
    expect(scheduler.addUtterance("hello there")).toBeNull();
    scheduler.addUtterance("two");
    scheduler.addUtterance("three");
    scheduler.addUtterance("four");
    expect(first).toMatch(/^pseg_/);
    expect(scheduler.getWindow().map((segment) => segment.text)).toEqual([
      "two",
      "three",
      "four",
    ]);
  });

  it("aborts an in-flight upload when paused", async () => {
    const pending = deferred<InsightsClientResult>();
    let input: RequestInsightsInput | undefined;
    const client: InsightsClient = {
      requestInsights: vi.fn((nextInput) => {
        input = nextInput;
        return pending.promise;
      }),
    };
    const onInsights = vi.fn();
    const scheduler = new PendantInsightsScheduler({
      client,
      onInsights,
      minSegments: 3,
      minIntervalMs: 0,
    });
    scheduler.setEnabled(true);
    scheduler.addUtterance("one");
    scheduler.addUtterance("two");
    scheduler.addUtterance("three");
    expect(input?.signal?.aborted).toBe(false);
    scheduler.setPaused(true);
    expect(input?.signal?.aborted).toBe(true);
    pending.resolve({ ok: true, insights: insights() });
    await pending.promise;
    await Promise.resolve();
    expect(onInsights).not.toHaveBeenCalled();
  });

  it("rate-limits failed attempts and retries only after cadence", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const requestInsights = vi.fn(
      async (): Promise<InsightsClientResult> => ({
        ok: false,
        skipped: false,
        error: "bad model output",
      }),
    );
    const scheduler = new PendantInsightsScheduler({
      client: { requestInsights },
      onInsights: vi.fn(),
      minSegments: 3,
      minIntervalMs: 1_000,
      now: () => now,
    });
    scheduler.setEnabled(true);
    scheduler.addUtterance("one");
    scheduler.addUtterance("two");
    scheduler.addUtterance("three");
    await Promise.resolve();
    await Promise.resolve();
    expect(requestInsights).toHaveBeenCalledTimes(1);
    scheduler.addUtterance("four");
    expect(requestInsights).toHaveBeenCalledTimes(1);
    now += 999;
    await vi.advanceTimersByTimeAsync(999);
    expect(requestInsights).toHaveBeenCalledTimes(1);
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(requestInsights).toHaveBeenCalledTimes(2);
  });

  it("preserves speech arriving in flight and schedules a follow-up pass", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const first = deferred<InsightsClientResult>();
    const requestInsights = vi
      .fn<InsightsClient["requestInsights"]>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ ok: true, insights: insights("second") });
    const scheduler = new PendantInsightsScheduler({
      client: { requestInsights },
      onInsights: vi.fn(),
      minSegments: 3,
      minIntervalMs: 100,
      now: () => now,
    });
    scheduler.setEnabled(true);
    for (const text of ["one", "two", "three"]) scheduler.addUtterance(text);
    for (const text of ["four", "five", "six"]) scheduler.addUtterance(text);
    first.resolve({ ok: true, insights: insights("first") });
    await first.promise;
    await Promise.resolve();
    expect(requestInsights).toHaveBeenCalledTimes(1);
    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(requestInsights).toHaveBeenCalledTimes(2);
  });
});

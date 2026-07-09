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

function success(summary = "summary"): InsightsClientResult {
  return {
    ok: true,
    insights: insights(summary),
    provenance: {
      sessionId: "stable",
      agentId: "agent-1",
      memoryId: "memory-1",
      sourceSegments: [{ id: "stable:segment:0", ordinal: 0, revision: 0 }],
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
      async (): Promise<InsightsClientResult> => success(),
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
    expect(first).toBe("stable:segment:0");
    expect(scheduler.getWindow().map((segment) => segment.text)).toEqual([
      "two",
      "three",
      "four",
    ]);
  });

  it("accepts canonical session segments by shared id and nullable speaker id", () => {
    const scheduler = new PendantInsightsScheduler({
      client: { requestInsights: vi.fn() },
      onInsights: vi.fn(),
      minSegments: 100,
      sessionId: "shared",
    });
    scheduler.setEnabled(true);
    const first = {
      id: "shared:segment:4",
      sessionId: "shared",
      ordinal: 4,
      revision: 0,
      text: "repeat this",
      speakerCluster: null,
      speakerAlias: null,
      startedAt: "2026-07-09T20:00:00.000Z",
    };
    const revisedFirst = {
      ...first,
      revision: 1,
      text: "repeat this, corrected",
    };
    const second = {
      id: "shared:segment:5",
      sessionId: "shared",
      ordinal: 5,
      revision: 0,
      text: "repeat this",
      speakerCluster: "spk_1",
      speakerAlias: "Speaker 1",
      startedAt: "2026-07-09T20:00:01.000Z",
    };
    expect(scheduler.addSegment(first)).toBe(true);
    expect(scheduler.addSegment(first)).toBe(false);
    expect(scheduler.addSegment(revisedFirst)).toBe(true);
    expect(scheduler.addSegment(second)).toBe(true);
    expect(scheduler.getWindow()).toEqual([
      {
        id: revisedFirst.id,
        sessionId: "shared",
        ordinal: 4,
        revision: 1,
        text: revisedFirst.text,
        speakerId: null,
        atMs: Date.parse(first.startedAt),
      },
      {
        id: second.id,
        sessionId: "shared",
        ordinal: 5,
        revision: 0,
        text: second.text,
        speakerId: "spk_1",
        speakerLabel: "Speaker 1",
        atMs: Date.parse(second.startedAt),
      },
    ]);
  });

  it("omits malformed session-sync timestamps instead of poisoning a request", () => {
    const scheduler = new PendantInsightsScheduler({
      client: { requestInsights: vi.fn() },
      onInsights: vi.fn(),
      minSegments: 100,
      sessionId: "timestamps",
    });
    scheduler.setEnabled(true);
    expect(
      scheduler.addSegment({
        id: "timestamps:segment:0",
        sessionId: "timestamps",
        ordinal: 0,
        revision: 0,
        text: "valid text",
        startedAt: "not-a-date",
      }),
    ).toBe(true);
    expect(scheduler.getWindow()[0]).not.toHaveProperty("atMs");
  });

  it("marks a retained rollup stale as soon as new speech arrives", async () => {
    const states: string[] = [];
    const scheduler = new PendantInsightsScheduler({
      client: {
        requestInsights: vi.fn(async () => success()),
      },
      onInsights: vi.fn(),
      onStateChange: (state) =>
        states.push(`${state.status}:${state.freshness}`),
      minSegments: 3,
      minIntervalMs: 0,
    });
    scheduler.setEnabled(true);
    scheduler.addUtterance("one");
    scheduler.addUtterance("two");
    scheduler.addUtterance("three");
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.getState()).toMatchObject({
      status: "ready",
      freshness: "fresh",
      error: null,
    });
    scheduler.addUtterance("new context");
    expect(scheduler.getState()).toMatchObject({
      status: "idle",
      freshness: "stale",
      insights: insights(),
    });
    expect(states).toContain("ready:fresh");
    expect(states).toContain("idle:stale");
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
    expect(input?.sessionId).toMatch(/^s\d+$/);
    expect(input?.signal?.aborted).toBe(false);
    scheduler.setPaused(true);
    expect(input?.signal?.aborted).toBe(true);
    pending.resolve(success());
    await pending.promise;
    await Promise.resolve();
    expect(onInsights).not.toHaveBeenCalled();
  });

  it("aborts and forgets retained speech and insights on session delete", async () => {
    const pending = deferred<InsightsClientResult>();
    let signal: AbortSignal | undefined;
    const scheduler = new PendantInsightsScheduler({
      client: {
        requestInsights: vi.fn((input) => {
          signal = input.signal;
          return pending.promise;
        }),
      },
      onInsights: vi.fn(),
      minSegments: 3,
      minIntervalMs: 0,
      sessionId: "delete-me",
    });
    scheduler.setEnabled(true);
    for (const text of ["one", "two", "three"]) scheduler.addUtterance(text);
    scheduler.clearForSessionDelete();
    expect(signal?.aborted).toBe(true);
    expect(scheduler.isEnabled()).toBe(false);
    expect(scheduler.getWindow()).toEqual([]);
    expect(scheduler.getState()).toEqual({
      status: "disabled",
      freshness: "none",
      insights: null,
      provenance: null,
      lastUpdatedAt: null,
      error: null,
    });
    pending.resolve(success());
    await pending.promise;
    await Promise.resolve();
    expect(scheduler.getState().insights).toBeNull();
  });

  it("rate-limits failed attempts and exposes explicit error state", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const states: Array<{
      status: string;
      freshness: string;
      error: string | null;
    }> = [];
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
      onStateChange: (state) =>
        states.push({
          status: state.status,
          freshness: state.freshness,
          error: state.error,
        }),
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
    expect(states.at(-1)).toEqual({
      status: "error",
      freshness: "none",
      error: "bad model output",
    });
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
      .mockResolvedValue(success("second"));
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
    first.resolve(success("first"));
    await first.promise;
    await Promise.resolve();
    expect(requestInsights).toHaveBeenCalledTimes(1);
    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(requestInsights).toHaveBeenCalledTimes(2);
  });
});

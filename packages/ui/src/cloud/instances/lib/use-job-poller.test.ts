/** Verifies useJobPoller — sleep-wake / backgrounding lifecycle (#9943) through the package's configured test harness. */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useJobPoller } from "./use-job-poller";

/**
 * Sleep-wake / app-backgrounding lifecycle coverage (issue #9943).
 *
 * #9943 calls out that "sleep-wake, app backgrounding/foregrounding ... are
 * uncovered on every platform." `useJobPoller` is the renderer's concrete
 * backgrounding contract: its poll tick early-returns while
 * `document.visibilityState !== "visible"`, so a backgrounded tab stops hitting
 * the jobs API and resumes when foregrounded. This pins that contract without
 * the ~15-min cold-build e2e harness.
 */

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useJobPoller — sleep-wake / backgrounding lifecycle (#9943)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
    // Keep the job "in_progress" forever so it stays active (the poll loop
    // continues) and never triggers the completed/failed window.location.reload.
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { status: "in_progress" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("polls while foregrounded, PAUSES while backgrounded, RESUMES on foreground", async () => {
    const { result } = renderHook(() => useJobPoller({ intervalMs: 1_000 }));

    // Tracking an active job arms the poll effect (immediate poll + interval).
    await act(async () => {
      result.current.track("agent-1", "job-1");
      await Promise.resolve();
    });

    // Foreground: the mount poll fired at least once.
    const afterMount = fetchMock.mock.calls.length;
    expect(afterMount).toBeGreaterThanOrEqual(1);

    // Foreground: each interval tick polls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const afterForegroundTick = fetchMock.mock.calls.length;
    expect(afterForegroundTick).toBeGreaterThan(afterMount);

    // Background the app: the interval keeps firing, but every tick early-returns
    // on `visibilityState !== "visible"` — so NO new jobs API calls.
    setVisibility("hidden");
    const beforeBackground = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000); // 3 ticks while hidden
    });
    expect(fetchMock.mock.calls.length).toBe(beforeBackground);

    // Foreground again: polling resumes.
    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(beforeBackground);
  });

  it("aborts a hung poll hop at the per-poll timeout instead of pinning the poller", async () => {
    // A jobs endpoint that never settles on its own: the only way out is the
    // caller's AbortSignal firing (the per-poll `AbortSignal.timeout(10s)`).
    // Note: Node's AbortSignal.timeout uses an internal timer that vitest fake
    // timers cannot drive, so back it with the faked global setTimeout here.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    const hungFetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            ),
          );
        }),
    );
    vi.stubGlobal("fetch", hungFetch);
    const { result } = renderHook(() => useJobPoller({ intervalMs: 60_000 }));

    // Tracking an active job arms the poll effect (immediate poll + interval).
    await act(async () => {
      result.current.track("agent-1", "job-1");
      await Promise.resolve();
    });
    expect(hungFetch).toHaveBeenCalledTimes(1);
    expect(hungFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    // The hung hop aborts after the 10s bound; the in-flight guard resets in
    // the finally block, so the NEXT interval tick still fires a fresh poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(hungFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps an active server job authoritative past the old ten-minute client deadline", async () => {
    const { result } = renderHook(() =>
      useJobPoller({ intervalMs: 60_000, autoRefresh: false }),
    );

    await act(async () => {
      result.current.track("agent-1", "job-1", {
        status: "in_progress",
        startedAt: Date.now(),
      });
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    });

    expect(result.current.getStatus("agent-1")?.status).toBe("in_progress");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("reattaches when the server advances another attempt on the same job id", async () => {
    const onFailed = vi.fn();
    const { result } = renderHook(() =>
      useJobPoller({
        intervalMs: 1_000,
        maxDurationMs: 500,
        autoRefresh: false,
        onFailed,
      }),
    );
    const firstStartedAt = Date.now();

    await act(async () => {
      result.current.track("agent-1", "job-1", {
        status: "in_progress",
        startedAt: firstStartedAt,
        attempts: 0,
        maxAttempts: 3,
      });
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.getStatus("agent-1")?.status).toBe("failed");
    expect(onFailed).toHaveBeenCalledTimes(1);

    const retryStartedAt = firstStartedAt + 2_000;
    await act(async () => {
      result.current.track("agent-1", "job-1", {
        status: "in_progress",
        startedAt: retryStartedAt,
        attempts: 1,
        maxAttempts: 3,
      });
      await Promise.resolve();
    });

    expect(result.current.getStatus("agent-1")).toMatchObject({
      jobId: "job-1",
      status: "in_progress",
      error: null,
      startedAt: retryStartedAt,
      attempts: 1,
      maxAttempts: 3,
    });
  });

  it("does not regress a server-terminal job from a stale active snapshot", async () => {
    const { result } = renderHook(() =>
      useJobPoller({ intervalMs: 60_000, autoRefresh: false }),
    );

    await act(async () => {
      result.current.track("agent-1", "job-1", {
        status: "completed",
        startedAt: 2_000,
        attempts: 2,
        maxAttempts: 3,
      });
      result.current.track("agent-1", "job-1", {
        status: "in_progress",
        startedAt: 2_000,
        attempts: 2,
        maxAttempts: 3,
      });
      await Promise.resolve();
    });

    expect(result.current.getStatus("agent-1")).toMatchObject({
      status: "completed",
      startedAt: 2_000,
      attempts: 2,
      terminalSource: "server",
    });
  });

  it("does not let an older in-flight poll overwrite a terminal snapshot", async () => {
    let releasePoll: ((response: Response) => void) | undefined;
    const startedAt = Date.now();
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releasePoll = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useJobPoller({ intervalMs: 60_000, autoRefresh: false }),
    );

    await act(async () => {
      result.current.track("agent-1", "job-1", {
        status: "in_progress",
        startedAt,
        attempts: 2,
      });
      await Promise.resolve();
    });
    await act(async () => {
      result.current.track("agent-1", "job-1", {
        status: "completed",
        startedAt,
        attempts: 2,
      });
      releasePoll?.(
        Response.json({
          data: { status: "in_progress", attempts: 2 },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.getStatus("agent-1")).toMatchObject({
      status: "completed",
      attempts: 2,
      terminalSource: "server",
    });
  });

  it("rejects a same-job snapshot whose attempt decreases", async () => {
    const { result } = renderHook(() =>
      useJobPoller({ intervalMs: 60_000, autoRefresh: false }),
    );

    await act(async () => {
      result.current.track("agent-1", "job-1", {
        status: "in_progress",
        startedAt: 2_000,
        attempts: 2,
        maxAttempts: 3,
      });
      result.current.track("agent-1", "job-1", {
        status: "in_progress",
        startedAt: 3_000,
        attempts: 1,
        maxAttempts: 3,
      });
      await Promise.resolve();
    });

    expect(result.current.getStatus("agent-1")).toMatchObject({
      startedAt: 2_000,
      attempts: 2,
    });
  });

  it("fails closed when the authoritative job is no longer available", async () => {
    const onFailed = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const { result } = renderHook(() =>
      useJobPoller({ intervalMs: 60_000, autoRefresh: false, onFailed }),
    );

    await act(async () => {
      result.current.track("agent-1", "job-1");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.getStatus("agent-1")).toMatchObject({
      status: "failed",
      terminalSource: "unavailable",
    });
    expect(result.current.getStatus("agent-1")?.error).toContain(
      "no longer available",
    );
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it("fails closed after the bounded 45-minute default ceiling", async () => {
    const onFailed = vi.fn();
    const { result } = renderHook(() =>
      useJobPoller({ intervalMs: 60_000, autoRefresh: false, onFailed }),
    );

    await act(async () => {
      result.current.track("agent-1", "job-1", {
        status: "in_progress",
        startedAt: Date.now(),
      });
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45 * 60_000 + 60_000);
    });

    expect(result.current.getStatus("agent-1")).toMatchObject({
      status: "failed",
      terminalSource: "client_timeout",
    });
    expect(onFailed).toHaveBeenCalledTimes(1);
  });
});

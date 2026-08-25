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
});

// @vitest-environment jsdom

/**
 * Exercises the `usePollingTrajectories` hook against a stubbed `fetch` serving
 * real-shape list/detail envelopes, asserting it selects the active + last
 * trajectory, polls, and distinguishes the routes-unavailable state from errors.
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePollingTrajectories } from "./usePollingTrajectories.js";

const LIST = {
  trajectories: [
    { id: "active-1", status: "active", llmCallCount: 1 },
    { id: "done-1", status: "completed", llmCallCount: 2 },
  ],
  total: 2,
  offset: 0,
  limit: 10,
};

function detailFor(id: string) {
  return {
    trajectory: { id, status: id === "active-1" ? "active" : "completed" },
    llmCalls: [
      {
        id: `${id}-c1`,
        model: "m",
        response: '{"action":"RESPOND"}',
        purpose: "should_respond",
        actionType: "",
        stepType: "should_respond",
      },
    ],
    providerAccesses: [],
    toolEvents: [],
    evaluationEvents: [],
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("usePollingTrajectories", () => {
  it("selects the active trajectory as 'active' and the first non-active as 'last'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.startsWith("/api/trajectories?")) {
          return { ok: true, json: async () => LIST } as unknown as Response;
        }
        const id = decodeURIComponent(url.split("/api/trajectories/")[1] ?? "");
        return {
          ok: true,
          json: async () => detailFor(id),
        } as unknown as Response;
      }),
    );

    const { result } = renderHook(() => usePollingTrajectories(true));

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.active?.id).toBe("active-1");
    expect(result.current.last?.id).toBe("done-1");
    expect(result.current.activeDetail?.trajectory.id).toBe("active-1");
    expect(result.current.lastDetail?.trajectory.id).toBe("done-1");
  });

  it("surfaces an error string when the list fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "kaboom",
      })) as unknown as typeof fetch,
    );

    const { result } = renderHook(() => usePollingTrajectories(true));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toContain(
      "[trajectory-logger] 500 Internal Server Error",
    );
    expect(result.current.active).toBeNull();
  });

  it("degrades a failing detail fetch to null without erroring (per-detail .catch)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.startsWith("/api/trajectories?")) {
          return { ok: true, json: async () => LIST } as unknown as Response;
        }
        // The detail endpoint fails for every id.
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          text: async () => "missing",
        } as unknown as Response;
      }),
    );

    const { result } = renderHook(() => usePollingTrajectories(true));

    await waitFor(() => expect(result.current.ready).toBe(true));
    // List still resolved -> active/last selected, but details degraded to null.
    expect(result.current.error).toBeNull();
    expect(result.current.active?.id).toBe("active-1");
    expect(result.current.activeDetail).toBeNull();
    expect(result.current.lastDetail).toBeNull();
  });

  it("does not update state after unmount (aborts in-flight requests)", async () => {
    // Deferred so the test can resolve the in-flight list fetch AFTER unmount.
    let resolveList!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            // Reject if aborted (mirrors real fetch AbortController behavior).
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
            void pending.then(resolve);
          }),
      ) as unknown as typeof fetch,
    );

    const { result, unmount } = renderHook(() => usePollingTrajectories(true));
    // Initial state, no resolution yet.
    expect(result.current.ready).toBe(false);

    unmount();
    // Resolve the in-flight list fetch AFTER unmount; the `cancelled` guard must
    // prevent any setState (no throw, state stays at initial).
    resolveList({
      ok: true,
      json: async () => LIST,
    } as unknown as Response);
    await Promise.resolve();
    expect(result.current.ready).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("re-ticks on the 700ms interval (a second poll fires after the timer)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.startsWith("/api/trajectories?")) {
        return { ok: true, json: async () => LIST } as unknown as Response;
      }
      const id = decodeURIComponent(url.split("/api/trajectories/")[1] ?? "");
      return {
        ok: true,
        json: async () => detailFor(id),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => usePollingTrajectories(true));

    // Flush the first tick (list + 2 details).
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const firstTickListCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith("/api/trajectories?"),
    ).length;
    expect(firstTickListCalls).toBe(1);

    // Advance past POLL_MS (700ms) -> a second tick schedules another list fetch.
    await vi.advanceTimersByTimeAsync(750);
    const afterTickListCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith("/api/trajectories?"),
    ).length;
    expect(afterTickListCalls).toBeGreaterThanOrEqual(2);
  });
});

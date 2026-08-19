// @vitest-environment jsdom
/**
 * useJobPoller fetch timeout — poll request must be bounded so a stalled
 * GET /api/v1/jobs/:id does not hang the 5s poll tick forever. Same signal
 * remains active through res.json().
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS,
  useJobPoller,
} from "./use-job-poller.ts";

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useJobPoller fetch timeout", () => {
  it("exposes DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS === 10_000", () => {
    expect(DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("hook passes AbortSignal.timeout(DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS) into fetch on each poll tick", async () => {
    vi.useFakeTimers();
    setVisibility("visible");

    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms: number) => origTimeout(ms));

    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { status: "completed" as const } }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload: vi.fn() },
    });

    const onComplete = vi.fn();

    const { result } = renderHook(() =>
      useJobPoller({
        intervalMs: 1_000,
        onComplete,
        autoRefresh: false,
      }),
    );

    await act(async () => {
      result.current.track("agent-1", "job-1");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(
      DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS,
    );
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const returnedSignal = timeoutSpy.mock.results[0].value as AbortSignal;
    expect(init.signal).toBe(returnedSignal);

    await act(async () => {
      await Promise.resolve();
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("headers-then-stalled-body: signal remains active through res.json() — stalled json is bounded by timeout and does not hang poller", async () => {
    vi.useFakeTimers();
    setVisibility("visible");

    const controllers: AbortController[] = [];
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms: number) => {
        expect(ms).toBe(DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS);
        const c = new AbortController();
        controllers.push(c);
        const reason = new DOMException("TimeoutError", "TimeoutError");
        setTimeout(() => c.abort(reason), DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS);
        return c.signal;
      });

    let jsonSignal: AbortSignal | undefined;
    const fetchSpy = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal as AbortSignal | undefined;
        return {
          ok: true,
          json: async () => {
            jsonSignal = signal;
            await new Promise<void>((_, reject) => {
              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener(
                "abort",
                () => reject((signal as AbortSignal).reason),
                { once: true },
              );
            });
            return { data: { status: "completed" } };
          },
        } as unknown as Response;
      },
    );
    vi.stubGlobal("fetch", fetchSpy);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload: vi.fn() },
    });

    const onComplete = vi.fn();
    const onFailed = vi.fn();

    const { result } = renderHook(() =>
      useJobPoller({
        intervalMs: 1_000,
        onComplete,
        onFailed,
        autoRefresh: false,
      }),
    );

    await act(async () => {
      result.current.track("k", "job-stall");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(
      DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS,
    );
    const stalledSignal = controllers[0].signal;
    expect(stalledSignal.aborted).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(jsonSignal).toBe(stalledSignal);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS + 10);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(stalledSignal.aborted).toBe(true);
    expect(stalledSignal.reason).toMatchObject({ name: "TimeoutError" });
    expect(onComplete).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("a later tick/retry can still succeed after a timeout-bounded stall", async () => {
    vi.useFakeTimers();
    setVisibility("visible");

    const controllers: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      expect(ms).toBe(DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS);
      const c = new AbortController();
      controllers.push(c);
      if (controllers.length === 1) {
        const reason = new DOMException("TimeoutError", "TimeoutError");
        setTimeout(() => c.abort(reason), 20);
      }
      return c.signal;
    });

    let callCount = 0;
    const fetchSpy = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        callCount += 1;
        const signal = init?.signal as AbortSignal | undefined;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => {
              await new Promise<void>((_, reject) => {
                signal?.addEventListener(
                  "abort",
                  () => reject((signal as AbortSignal).reason),
                  { once: true },
                );
                if (signal?.aborted) reject(signal.reason);
              });
              return { data: { status: "completed" } };
            },
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({ data: { status: "completed" as const } }),
        } as unknown as Response;
      },
    );
    vi.stubGlobal("fetch", fetchSpy);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload: vi.fn() },
    });

    const onComplete = vi.fn();

    const { result } = renderHook(() =>
      useJobPoller({
        intervalMs: 1_000,
        onComplete,
        autoRefresh: false,
      }),
    );

    await act(async () => {
      result.current.track("k2", "job-retry");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(controllers[0].signal.aborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ status: "completed" });
  });

  it("exact/fast success and error/non-OK behavior: non-OK is retried, failed status calls onFailed, fetch throw is retried", async () => {
    vi.useFakeTimers();
    setVisibility("visible");

    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) =>
      origTimeout(ms),
    );

    let seq = 0;
    const fetchSpy = vi.fn(async (): Promise<Response> => {
      seq += 1;
      if (seq === 1) return { ok: false, status: 500 } as Response;
      if (seq === 2) throw new Error("network down");
      if (seq === 3)
        return {
          ok: true,
          json: async () => ({
            data: { status: "failed" as const, error: "boom" },
          }),
        } as unknown as Response;
      return {
        ok: true,
        json: async () => ({ data: { status: "completed" as const } }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload: vi.fn() },
    });

    const onComplete = vi.fn();
    const onFailed = vi.fn();

    const { result } = renderHook(() =>
      useJobPoller({
        intervalMs: 1_000,
        onComplete,
        onFailed,
        autoRefresh: false,
      }),
    );

    await act(async () => {
      result.current.track("k3", "job-seq");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(result.current.isActive("k3")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    });
    expect(onFailed).not.toHaveBeenCalled();
    expect(result.current.isActive("k3")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    });
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0][0]).toMatchObject({ status: "failed" });
  });
});

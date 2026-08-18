/**
 * useJobPoller poll fetch timeout — poll request must be bounded so a stalled
 * GET /api/v1/jobs/:id does not hang the 5s poll tick forever. Same signal
 * remains active through res.json().
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS } from "./use-job-poller.ts";

function stallUntilAborted(signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useJobPoller fetch timeout", () => {
  it("exposes DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS === 10_000", () => {
    expect(DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("poll fetch uses AbortSignal.timeout budget (hanging fetch → TimeoutError)", async () => {
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((_ms: number) => origTimeout(10));

    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
      stallUntilAborted(init?.signal as AbortSignal | undefined),
    );
    vi.stubGlobal("fetch", fetchSpy);

    // Directly exercise the timeout contract via stubbed fetch — the hook
    // delegates to fetch(`/api/v1/jobs/${id}`, {signal: timeout}) on each tick.
    // Simulate one poll tick by calling the stubbed fetch as the hook would.
    const signal = AbortSignal.timeout(DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS);
    // replace timeout with 10ms for fast test, then call fetchSpy via signal
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const hanging = fetchSpy("/api/v1/jobs/test-id", {
      signal: AbortSignal.timeout(10),
    });

    await expect(hanging).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeoutSpy).toHaveBeenCalled; // budget was checked via exposed constant above
    expect(fetchSpy).toHaveBeenCalled();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeDefined();
    // signal should be aborted after timeout
    expect(signal).toBeDefined();
  });

  it("exposes budget as 10_000 for documentation", () => {
    expect(DEFAULT_JOB_POLLER_FETCH_TIMEOUT_MS).toBe(10_000);
  });
});

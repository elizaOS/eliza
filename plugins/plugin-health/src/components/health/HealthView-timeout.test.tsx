/**
 * @vitest-environment jsdom
 *
 * Exercises HealthView sleep-JSON deadlines and caller cancellation through
 * the injectable HTTP boundary.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui/api", () => ({
  client: { getBaseUrl: () => "http://test.local" },
}));

import {
  getHealthJsonWithFetch,
  HEALTH_VIEW_JSON_TIMEOUT_MS,
} from "./HealthView.js";

const URL = "http://test.local/api/lifeops/sleep/history?windowDays=14";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected health-view abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("HealthView sleep JSON deadline", () => {
  it("keeps a documented UI JSON budget", () => {
    expect(HEALTH_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled sleep GET at the injected deadline", async () => {
    await expect(
      getHealthJsonWithFetch(URL, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed sleep GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    await expect(getHealthJsonWithFetch(URL, fetchImpl, 1_000)).rejects.toThrow(
      "503",
    );
  });

  it("preserves caller cancellation instead of reporting a timeout", async () => {
    const controller = new AbortController();
    const reason = new DOMException("view unmounted", "AbortError");
    const pending = getHealthJsonWithFetch(
      URL,
      stallUntilAborted(),
      1_000,
      controller.signal,
    );

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("uses the injected fetch for a successful sleep GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({
        episodes: [],
        summary: {
          cycleCount: 0,
          averageDurationMin: null,
          overnightCount: 0,
          napCount: 0,
          openCount: 0,
        },
        windowDays: 14,
        includeNaps: true,
      });
    };

    const body = await getHealthJsonWithFetch<{ windowDays: number }>(
      URL,
      fetchImpl,
      1_000,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(body.windowDays).toBe(14);
  });
});

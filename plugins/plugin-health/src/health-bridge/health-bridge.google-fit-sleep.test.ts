/**
 * Real-fetch regression coverage for the health-bridge Google Fit REST
 * fallback: spies on the global `fetch` and drives the actual
 * `getDailySummary`/`getDataPoints` code paths (no connector stub) to pin the
 * fix for #12798 (fallback-slop LifeOps/health).
 *
 * Google Fit daily summaries fetch steps/active-minutes with one aggregate
 * call and sleep with a second, dedicated call. Previously a failure of the
 * sleep sub-fetch was swallowed and the summary kept `sleepHours: 0`, which is
 * indistinguishable from a genuine zero-sleep day and silently corrupts
 * circadian/regularity inference downstream.
 *
 * The fix marks such days `sleepUnavailable: true` (distinct from
 * "slept 0 hours") and logs the failure as a structured warn so it is
 * observable, and omits those days from sleep data-point series instead of
 * emitting fabricated zero-sleep points.
 */
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDailySummary, getDataPoints } from "./health-bridge.js";

type FetchArgs = Parameters<typeof fetch>;

const GOOGLE_FIT_CONFIG = {
  preferredBackend: "google-fit" as const,
  googleFitAccessToken: "test-token",
};

function requestBodyText(init: FetchArgs[1]): string {
  const body = init?.body;
  return typeof body === "string" ? body : String(body ?? "");
}

function isSleepRequest(init: FetchArgs[1]): boolean {
  return requestBodyText(init).includes("com.google.sleep.segment");
}

/** A metrics-aggregate response with real step/active data but no sleep. */
function metricsResponseBody(): string {
  return JSON.stringify({
    bucket: [
      {
        startTimeMillis: "0",
        endTimeMillis: "86400000",
        dataset: [
          { point: [{ value: [{ intVal: 8000 }] }] }, // steps
          { point: [{ value: [{ fpVal: 42 }] }] }, // active minutes
          { point: [] }, // calories
          { point: [] }, // distance
          { point: [] }, // heart rate
        ],
      },
    ],
  });
}

/** A sleep-aggregate response carrying ~7h of sleep. */
function sleepResponseBody(): string {
  const startNanos = "0";
  const endNanos = String(7 * 60 * 60 * 1_000_000_000); // 7h in ns
  return JSON.stringify({
    bucket: [
      {
        dataset: [
          {
            point: [{ startTimeNanos: startNanos, endTimeNanos: endNanos }],
          },
        ],
      },
    ],
  });
}

function okResponse(bodyText: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(bodyText),
  } as unknown as Response;
}

function failResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

describe("googleFitDailySummary sleep sub-fetch failure (#12798)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks the day sleepUnavailable when the sleep aggregation fails (does not fabricate sleepHours: 0)", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    fetchSpy.mockImplementation((async (
      _url: FetchArgs[0],
      init: FetchArgs[1],
    ) => {
      if (isSleepRequest(init)) {
        return failResponse(503);
      }
      return okResponse(metricsResponseBody());
    }) as typeof fetch);

    const summary = await getDailySummary("2026-07-01", GOOGLE_FIT_CONFIG);

    // Steps/active minutes from the successful metrics call still land.
    expect(summary.steps).toBe(8000);
    expect(summary.activeMinutes).toBe(42);
    // The failed sleep sub-fetch must be flagged, NOT reported as 0h slept.
    expect(summary.sleepUnavailable).toBe(true);
    expect(summary.sleepHours).toBe(0);
    // The failure must have hit the aggregate endpoint twice (metrics + sleep).
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      {
        boundary: "lifeops",
        integration: "google-fit",
        date: "2026-07-01",
        error: "Google Fit request failed: HTTP 503",
      },
      "[lifeops] Google Fit sleep aggregation failed; sleep marked unavailable for this day",
    );
  });

  it("does NOT set sleepUnavailable and reports real sleep when the sleep call succeeds", async () => {
    fetchSpy.mockImplementation((async (
      _url: FetchArgs[0],
      init: FetchArgs[1],
    ) => {
      if (isSleepRequest(init)) {
        return okResponse(sleepResponseBody());
      }
      return okResponse(metricsResponseBody());
    }) as typeof fetch);

    const summary = await getDailySummary("2026-07-01", GOOGLE_FIT_CONFIG);

    expect(summary.sleepUnavailable).toBeUndefined();
    expect(summary.sleepHours).toBeCloseTo(7, 5);
  });

  it("does NOT set sleepUnavailable for a genuine zero-sleep day (empty sleep dataset)", async () => {
    const emptySleepBody = JSON.stringify({
      bucket: [{ dataset: [{ point: [] }] }],
    });
    fetchSpy.mockImplementation((async (
      _url: FetchArgs[0],
      init: FetchArgs[1],
    ) => {
      if (isSleepRequest(init)) {
        return okResponse(emptySleepBody);
      }
      return okResponse(metricsResponseBody());
    }) as typeof fetch);

    const summary = await getDailySummary("2026-07-01", GOOGLE_FIT_CONFIG);

    // Real zero-sleep: known 0, distinct from a failed connector.
    expect(summary.sleepUnavailable).toBeUndefined();
    expect(summary.sleepHours).toBe(0);
  });

  it("omits sleep-unavailable days from sleep data-point series (no fabricated points)", async () => {
    // Sleep aggregate fails for every day in the window -> no points emitted,
    // rather than a run of fabricated zero-sleep points.
    fetchSpy.mockImplementation((async (
      _url: FetchArgs[0],
      init: FetchArgs[1],
    ) => {
      if (isSleepRequest(init)) {
        return failResponse(500);
      }
      return okResponse(metricsResponseBody());
    }) as typeof fetch);

    const points = await getDataPoints(
      {
        metric: "sleep_hours",
        startAt: "2026-07-01T00:00:00.000Z",
        endAt: "2026-07-02T00:00:00.000Z",
      },
      GOOGLE_FIT_CONFIG,
    );

    expect(points).toEqual([]);
  });
});

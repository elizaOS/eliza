/**
 * Google Fit day windows follow the owner's local calendar day. Drives the real
 * `getDailySummary`/`getDataPoints` Google Fit paths with a stubbed global
 * `fetch` and asserts the exact instant window sent to the aggregate API, so a
 * day outside UTC never borrows hours from its neighbours and DST days span 23
 * or 25 hours. Deterministic; independent of the process timezone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getDailySummary,
  getDataPoints,
  HealthBridgeError,
} from "./health-bridge.js";

type FetchArgs = Parameters<typeof fetch>;

const HOUR_MS = 60 * 60 * 1000;

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

/** Records every aggregate window and answers with ~7h of sleep. */
function stubGoogleFit(): Array<{
  startTimeMillis: number;
  endTimeMillis: number;
}> {
  const windows: Array<{ startTimeMillis: number; endTimeMillis: number }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_input: FetchArgs[0], init?: FetchArgs[1]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        startTimeMillis: number;
        endTimeMillis: number;
      };
      windows.push({
        startTimeMillis: body.startTimeMillis,
        endTimeMillis: body.endTimeMillis,
      });
      return okResponse({
        bucket: [
          {
            dataset: [
              {
                point: [
                  {
                    startTimeNanos: "0",
                    endTimeNanos: String(7 * HOUR_MS * 1_000_000),
                    value: [{ intVal: 1 }],
                  },
                ],
              },
            ],
          },
        ],
      });
    },
  );
  return windows;
}

function config(timeZone: string) {
  return {
    preferredBackend: "google-fit" as const,
    googleFitAccessToken: "test-token",
    timeZone,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Google Fit daily summary window", () => {
  it.each([
    ["UTC", "2026-10-02", "2026-10-02T00:00:00.000Z", 24],
    ["Asia/Kolkata", "2026-10-02", "2026-10-01T18:30:00.000Z", 24],
    ["America/New_York", "2026-03-08", "2026-03-08T05:00:00.000Z", 23],
    ["Europe/London", "2026-10-25", "2026-10-24T23:00:00.000Z", 25],
  ])(
    "bounds %s %s at local midnight",
    async (timeZone, date, startIso, hours) => {
      const windows = stubGoogleFit();

      await getDailySummary(date, config(timeZone));

      expect(windows.length).toBeGreaterThan(0);
      for (const window of windows) {
        expect(new Date(window.startTimeMillis).toISOString()).toBe(startIso);
        expect(window.endTimeMillis - window.startTimeMillis).toBe(
          hours * HOUR_MS,
        );
      }
    },
  );

  it("rejects a date that is not a calendar day", async () => {
    stubGoogleFit();

    await expect(
      getDailySummary("2026-02-30", config("UTC")),
    ).rejects.toBeInstanceOf(HealthBridgeError);
  });
});

describe("Google Fit sleep series days", () => {
  it("enumerates the owner's local days and bounds each point by them", async () => {
    const windows = stubGoogleFit();

    const points = await getDataPoints(
      {
        metric: "sleep_hours",
        // 2026-10-01 20:00 to 2026-10-02 20:00 in Tokyo (+09:00).
        startAt: "2026-10-01T11:00:00.000Z",
        endAt: "2026-10-02T11:00:00.000Z",
      },
      config("Asia/Tokyo"),
    );

    expect(points.map((point) => [point.startAt, point.endAt])).toEqual([
      ["2026-09-30T15:00:00.000Z", "2026-10-01T14:59:59.999Z"],
      ["2026-10-01T15:00:00.000Z", "2026-10-02T14:59:59.999Z"],
    ]);
    expect(
      new Set(
        windows.map((window) => new Date(window.startTimeMillis).toISOString()),
      ),
    ).toEqual(
      new Set(["2026-09-30T15:00:00.000Z", "2026-10-01T15:00:00.000Z"]),
    );
  });
});

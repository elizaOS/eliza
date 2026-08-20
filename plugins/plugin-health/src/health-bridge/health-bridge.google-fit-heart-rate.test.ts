/**
 * Regression coverage for #22062: Google Fit heart-rate aggregation returns
 * `com.google.heart_rate.summary` points whose value array is
 * [average, max, min]. Previously the daily summary averaged all three
 * (heartRateAvg 80 for avg=70/max=120/min=50) and getDataPoints summed them
 * (240 bpm). Only the first value — the average — is a heart-rate reading.
 *
 * These tests exercise the real request path through the documented
 * `ELIZA_MOCK_GOOGLE_BASE` loopback seam, which was itself dead for Google
 * Fit (the rewrite regex matched only fitness.googleapis.com while the
 * aggregate URL uses www.googleapis.com) — same fix.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDailySummary, getDataPoints } from "./health-bridge.js";

const GOOGLE_FIT_CONFIG = {
  preferredBackend: "google-fit" as const,
  googleFitAccessToken: "test-token",
};

// One heart-rate summary point: average=70, max=120, min=50 bpm.
const hrPoint = { value: [{ fpVal: 70 }, { fpVal: 120 }, { fpVal: 50 }] };

let server: http.Server;
const seenUrls: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seenUrls.push(`http://${req.headers.host}${req.url}`);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as {
        aggregateBy?: { dataTypeName: string }[];
        startTimeMillis?: number;
      };
      const types = (parsed.aggregateBy ?? []).map((a) => a.dataTypeName);
      let bucket: unknown;
      if (types.includes("com.google.sleep.segment")) {
        bucket = { dataset: [{ point: [] }] };
      } else if (types.length === 1) {
        // getDataPoints path: one hourly bucket for the requested metric.
        const points =
          types[0] === "com.google.heart_rate.bpm"
            ? [hrPoint]
            : [{ value: [{ intVal: 3000 }] }, { value: [{ intVal: 5000 }] }];
        bucket = {
          startTimeMillis: String(parsed.startTimeMillis),
          endTimeMillis: String(Number(parsed.startTimeMillis) + 3_600_000),
          dataset: [{ point: points }],
        };
      } else {
        // daily summary: steps, active_minutes, calories, distance, heart_rate
        bucket = {
          dataset: [
            {
              point: [
                { value: [{ intVal: 3000 }] },
                { value: [{ intVal: 5000 }] },
              ],
            },
            {
              point: [{ value: [{ intVal: 10 }] }, { value: [{ intVal: 20 }] }],
            },
            { point: [] },
            { point: [] },
            { point: [hrPoint] },
          ],
        };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ bucket: [bucket] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.ELIZA_MOCK_GOOGLE_BASE = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.ELIZA_MOCK_GOOGLE_BASE;
  await new Promise<void>((r) => server.close(() => r()));
});

describe("Google Fit heart-rate summary aggregation (#22062)", () => {
  it("routes the Google Fit aggregate URL through ELIZA_MOCK_GOOGLE_BASE", async () => {
    seenUrls.length = 0;
    await getDailySummary("2026-08-10", GOOGLE_FIT_CONFIG);
    expect(seenUrls.length).toBeGreaterThan(0);
    for (const url of seenUrls) {
      expect(url).toContain("127.0.0.1");
      expect(url).toContain("/fitness/v1/users/me/dataset:aggregate");
    }
  });

  it("reports heartRateAvg as the summary point's average, not the mean of [avg,max,min]", async () => {
    const summary = await getDailySummary("2026-08-10", GOOGLE_FIT_CONFIG);
    expect(summary.heartRateAvg).toBe(70);
  });

  it("keeps sum semantics for the other daily-summary metrics", async () => {
    const summary = await getDailySummary("2026-08-10", GOOGLE_FIT_CONFIG);
    expect(summary.steps).toBe(8000);
    expect(summary.activeMinutes).toBe(30);
  });

  it("emits heart_rate data points as bucket averages, not sums (70 bpm, not 240)", async () => {
    const points = await getDataPoints(
      {
        metric: "heart_rate",
        startAt: "2026-08-10T00:00:00Z",
        endAt: "2026-08-10T01:00:00Z",
      },
      GOOGLE_FIT_CONFIG,
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBe(70);
  });

  it("leaves steps data points summed as before", async () => {
    const points = await getDataPoints(
      {
        metric: "steps",
        startAt: "2026-08-10T00:00:00Z",
        endAt: "2026-08-10T01:00:00Z",
      },
      GOOGLE_FIT_CONFIG,
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBe(8000);
  });
});

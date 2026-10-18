/**
 * Google Fit `com.google.sleep.segment` points carry their stage in
 * `value[0].intVal` (1 awake, 2 sleep, 3 out of bed, 4 light, 5 deep, 6 REM).
 * Sleep hours count only the sleep stages, and only the part of each segment
 * inside the requested window. Real request path through the
 * `ELIZA_MOCK_GOOGLE_BASE` loopback seam.
 */
import http from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";

import { getDailySummary, getDataPoints } from "./health-bridge.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DAY_2026_10_14_MS = Date.UTC(2026, 9, 14);
const nanos = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
// Hours are offsets from 2026-10-14 00:00 UTC.
const segment = (fromHour: number, toHour: number, stage: number) => ({
  startTimeNanos: nanos(DAY_2026_10_14_MS + fromHour * HOUR_MS),
  endTimeNanos: nanos(DAY_2026_10_14_MS + toHour * HOUR_MS),
  value: [{ intVal: stage }],
});
// Nightly sleep 23:00 -> 07:00 UTC (offset hours), for the window test.
const NIGHTS = [72, 96].map((night) => segment(night - 1, night + 7, 2));

let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body) as {
        aggregateBy?: { dataTypeName: string }[];
        startTimeMillis: number;
        endTimeMillis: number;
      };
      const types = (request.aggregateBy ?? []).map(
        (entry) => entry.dataTypeName,
      );
      // Like Fit, return every whole segment that overlaps the request.
      const overlapping = [
        segment(0, 2, 4), // light
        segment(2, 3, 1), // awake
        segment(3, 6, 5), // deep
        segment(6, 7, 6), // REM
        segment(7, 7.5, 3), // out of bed
        ...NIGHTS,
      ].filter(
        (point) =>
          Number(BigInt(point.startTimeNanos) / 1_000_000n) <
            Number(request.endTimeMillis) &&
          Number(BigInt(point.endTimeNanos) / 1_000_000n) >
            Number(request.startTimeMillis),
      );
      const bucket = types.includes("com.google.sleep.segment")
        ? { dataset: [{ point: overlapping }] }
        : {
            dataset: [
              { point: [] },
              { point: [] },
              { point: [] },
              { point: [] },
              { point: [] },
            ],
          };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ bucket: [bucket] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  process.env.ELIZA_MOCK_GOOGLE_BASE = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.ELIZA_MOCK_GOOGLE_BASE;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("counts light, deep and REM sleep but not awake or out-of-bed time", async () => {
  const summary = await getDailySummary("2026-10-14", {
    preferredBackend: "google-fit",
    googleFitAccessToken: "test-token",
    timeZone: "UTC",
  });
  expect(summary.sleepHours).toBe(6);
});

it("counts only the sleep inside a trailing window", async () => {
  // 2026-10-17 12:00 -> 2026-10-18 12:00 UTC holds one night: 23:00 -> 07:00.
  const endMs = DAY_2026_10_14_MS + 4 * DAY_MS + 12 * HOUR_MS;
  const points = await getDataPoints(
    {
      metric: "sleep_hours",
      startAt: new Date(endMs - DAY_MS).toISOString(),
      endAt: new Date(endMs).toISOString(),
    },
    {
      preferredBackend: "google-fit",
      googleFitAccessToken: "test-token",
      timeZone: "UTC",
    },
  );
  expect(points.reduce((total, point) => total + point.value, 0)).toBe(8);
});

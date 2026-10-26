/**
 * A night that crosses midnight is one sleep on the day the owner woke up.
 * Google Fit's `sessions.list` returns the sleep sessions that end in the
 * requested range, and the segments of each session are read in full. Real
 * request path through the `ELIZA_MOCK_GOOGLE_BASE` loopback seam; the mock
 * answers as the documented API does (sessions by end time, segments clipped
 * to the requested range).
 */
import http from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";

import { getDailySummary } from "./health-bridge.js";

// 23:00 UTC on Oct 13 to 07:00 UTC on Oct 14: light sleep the whole night.
const NIGHT = {
  startMs: Date.parse("2026-10-13T23:00:00.000Z"),
  endMs: Date.parse("2026-10-14T07:00:00.000Z"),
};

let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url?.includes("/users/me/sessions")) {
      const query = new URL(req.url, "http://127.0.0.1").searchParams;
      const from = Date.parse(query.get("startTime") ?? "");
      const to = Date.parse(query.get("endTime") ?? "");
      const ends = NIGHT.endMs >= from && NIGHT.endMs <= to;
      res.end(
        JSON.stringify({
          session: ends
            ? [
                {
                  startTimeMillis: String(NIGHT.startMs),
                  endTimeMillis: String(NIGHT.endMs),
                  activityType: 72,
                },
              ]
            : [],
        }),
      );
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body) as {
        aggregateBy?: { dataTypeName: string }[];
        startTimeMillis: number;
        endTimeMillis: number;
      };
      const isSleep = (request.aggregateBy ?? []).some(
        (entry) => entry.dataTypeName === "com.google.sleep.segment",
      );
      if (!isSleep) {
        res.end(
          JSON.stringify({
            bucket: [{ dataset: [0, 1, 2, 3, 4].map(() => ({ point: [] })) }],
          }),
        );
        return;
      }
      const from = Math.max(NIGHT.startMs, request.startTimeMillis);
      const to = Math.min(NIGHT.endMs, request.endTimeMillis);
      const point =
        to > from
          ? [
              {
                startTimeNanos: String(from * 1_000_000),
                endTimeNanos: String(to * 1_000_000),
                value: [{ intVal: 4 }],
              },
            ]
          : [];
      res.end(JSON.stringify({ bucket: [{ dataset: [{ point }] }] }));
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

const config = {
  preferredBackend: "google-fit" as const,
  googleFitAccessToken: "test-token",
  timeZone: "UTC",
};

it("counts the whole night on the day the owner woke up", async () => {
  const summary = await getDailySummary("2026-10-14", config);
  expect(summary.sleepHours).toBe(8);
});

it("does not count part of that night on the day before", async () => {
  const summary = await getDailySummary("2026-10-13", config);
  expect(summary.sleepHours).toBe(0);
  expect(summary.sleepUnavailable).toBeUndefined();
});

it("counts the same night on the Tokyo wake day", async () => {
  const summary = await getDailySummary("2026-10-14", {
    ...config,
    timeZone: "Asia/Tokyo",
  });
  // 08:00 to 16:00 in Tokyo, ending on Oct 14.
  expect(summary.sleepHours).toBe(8);
});

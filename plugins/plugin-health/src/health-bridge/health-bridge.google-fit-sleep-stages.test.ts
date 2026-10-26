/**
 * Google Fit `com.google.sleep.segment` points carry their stage in
 * `value[0].intVal` (1 awake, 2 sleep, 3 out of bed, 4 light, 5 deep, 6 REM).
 * Sleep hours count only the sleep stages. Real request path through the
 * `ELIZA_MOCK_GOOGLE_BASE` loopback seam.
 */
import http from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";

import { getDailySummary } from "./health-bridge.js";

const HOUR_NS = 3_600_000_000_000;
const segment = (fromHour: number, toHour: number, stage: number) => ({
  startTimeNanos: String(fromHour * HOUR_NS),
  endTimeNanos: String(toHour * HOUR_NS),
  value: [{ intVal: stage }],
});

let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.includes("/users/me/sessions")) {
      // One sleep session around the recorded segments.
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          session: [
            {
              startTimeMillis: "0",
              endTimeMillis: String((7.5 * HOUR_NS) / 1_000_000),
              activityType: 72,
            },
          ],
        }),
      );
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const types = (
        (JSON.parse(body) as { aggregateBy?: { dataTypeName: string }[] })
          .aggregateBy ?? []
      ).map((entry) => entry.dataTypeName);
      const bucket = types.includes("com.google.sleep.segment")
        ? {
            dataset: [
              {
                point: [
                  segment(0, 2, 4), // light
                  segment(2, 3, 1), // awake
                  segment(3, 6, 5), // deep
                  segment(6, 7, 6), // REM
                  segment(7, 7.5, 3), // out of bed
                ],
              },
            ],
          }
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
  });
  expect(summary.sleepHours).toBe(6);
});

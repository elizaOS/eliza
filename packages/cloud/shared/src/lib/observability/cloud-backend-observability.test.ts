/** Ensures Cloud request telemetry records both successful and thrown requests. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
  clearCloudTelemetry,
  getCloudTelemetrySnapshot,
  observeCloudRequest,
} from "./cloud-backend-observability";

describe("observeCloudRequest", () => {
  beforeEach(() => clearCloudTelemetry());

  test("records the application trace id on success", async () => {
    await observeCloudRequest(
      {
        id: "request-1",
        traceId: "trace-12345678",
        method: "GET",
        path: "/health",
      },
      async () => ({ result: undefined, status: 204 }),
    );

    expect(getCloudTelemetrySnapshot().requests[0]).toMatchObject({
      id: "request-1",
      traceId: "trace-12345678",
      status: 204,
    });
  });

  test("finalizes a thrown request without intercepting the error", async () => {
    const failure = new TypeError("boom");
    await expect(
      observeCloudRequest({ id: "request-2", method: "POST", path: "/explode" }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(getCloudTelemetrySnapshot().requests[0]).toMatchObject({
      id: "request-2",
      status: 500,
    });
  });

  test("records the final Hono error response status", async () => {
    const app = new Hono();
    app.onError((_error, c) => c.json({ error: "internal" }, 500));
    app.use("*", async (c, next) =>
      observeCloudRequest(
        {
          id: "request-hono",
          traceId: "trace-hono-12345678",
          method: c.req.method,
          path: c.req.path,
        },
        async () => {
          await next();
          return { result: undefined, status: c.res.status };
        },
      ),
    );
    app.get("/explode", () => {
      throw new Error("route failure");
    });

    expect((await app.request("/explode")).status).toBe(500);
    expect(getCloudTelemetrySnapshot().requests[0]).toMatchObject({
      id: "request-hono",
      traceId: "trace-hono-12345678",
      status: 500,
    });
  });
});

describe("telemetry threshold env parsing", () => {
  const KEYS = [
    "CLOUD_SLOW_DB_MS",
    "CLOUD_SLOW_REQUEST_MS",
    "CLOUD_DB_BURST_COUNT",
  ];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of KEYS) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
    }
    clearCloudTelemetry();
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  test("ignores a trailing-garbage threshold instead of publishing its prefix", () => {
    // parseInt("500junk") is 500, so the snapshot reported a slow-DB boundary
    // of 500ms — a value nobody configured — and classified against it.
    process.env.CLOUD_SLOW_DB_MS = "500junk";
    expect(getCloudTelemetrySnapshot().thresholds.slowDbMs).toBe(250);
  });

  test("still honours a clean threshold", () => {
    process.env.CLOUD_SLOW_DB_MS = "500";
    expect(getCloudTelemetrySnapshot().thresholds.slowDbMs).toBe(500);
  });

  test("still honours an explicitly signed positive threshold", () => {
    // `Number.parseInt` accepted "+500"; rejecting it would be a regression.
    process.env.CLOUD_SLOW_DB_MS = "+500";
    expect(getCloudTelemetrySnapshot().thresholds.slowDbMs).toBe(500);
  });

  test("falls back for an integer beyond the safe range", () => {
    // This patch tightens the predicate from finite to safe-integer, so the
    // boundary it claims is covered explicitly.
    process.env.CLOUD_SLOW_DB_MS = "9007199254740993";
    expect(getCloudTelemetrySnapshot().thresholds.slowDbMs).toBe(250);
  });
});

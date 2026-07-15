/** Ensures Cloud request telemetry records both successful and thrown requests. */
import { beforeEach, describe, expect, test } from "bun:test";
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

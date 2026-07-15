/**
 * Verifies the global telemetry middleware against both mutable handler
 * responses and workerd-style immutable-header responses (raw fetch
 * passthrough). The immutable case is simulated by shadowing the Headers
 * mutators with the same TypeError workerd throws, proving a healthy proxied
 * response is re-wrapped with telemetry headers instead of 500ing.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { ELIZA_TRACE_ID_HEADER } from "./http-telemetry";
import { httpTelemetryMiddleware, shouldDecorateHttpTelemetryStatus } from "./http-telemetry-hono";

function immutableHeadersResponse(body: string, init: ResponseInit): Response {
  const response = new Response(body, init);
  const frozen = () => {
    throw new TypeError("Can't modify immutable headers.");
  };
  // workerd marks headers from a fetched Response immutable; shadow the
  // mutators on this instance to reproduce the exact failure mode.
  for (const method of ["set", "append", "delete"] as const) {
    Object.defineProperty(response.headers, method, { value: frozen });
  }
  return response;
}

describe("httpTelemetryMiddleware", () => {
  it("keeps status-101 upgrades outside telemetry's standard-field-only fallback", () => {
    expect(shouldDecorateHttpTelemetryStatus(101)).toBe(false);
    expect(shouldDecorateHttpTelemetryStatus(200)).toBe(true);
  });

  it("stamps trace id + Server-Timing on a mutable handler response", async () => {
    const app = new Hono();
    app.use("*", httpTelemetryMiddleware());
    app.get("/ok", (c) => c.json({ ok: true }));

    const res = await app.request("/ok", {
      headers: { "X-Eliza-Trace-Id": "44444444-4444-4444-8444-444444444444" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(ELIZA_TRACE_ID_HEADER)).toBe("44444444-4444-4444-8444-444444444444");
    expect(res.headers.get("Server-Timing")).toContain("cloud_worker;dur=");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("re-wraps an immutable-headers (raw fetch) response instead of throwing", async () => {
    const app = new Hono();
    app.use("*", httpTelemetryMiddleware());
    app.get("/proxied", () =>
      immutableHeadersResponse("proxied-bytes", {
        status: 201,
        statusText: "Created",
        headers: { "content-type": "text/plain", "x-upstream": "kept" },
      }),
    );

    const res = await app.request("/proxied", {
      headers: { "X-Eliza-Trace-Id": "55555555-5555-4555-8555-555555555555" },
    });

    // The healthy proxied response survives with body, status, and upstream
    // headers intact — and still gains the telemetry headers.
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("proxied-bytes");
    expect(res.headers.get("x-upstream")).toBe("kept");
    expect(res.headers.get(ELIZA_TRACE_ID_HEADER)).toBe("55555555-5555-4555-8555-555555555555");
    expect(res.headers.get("Server-Timing")).toContain("cloud_worker;dur=");
  });

  it("rethrows non-TypeError failures from header mutation", async () => {
    const app = new Hono();
    app.use("*", httpTelemetryMiddleware());
    app.onError((_err, c) => c.text("boundary", 500));
    app.get("/broken", () => {
      const response = new Response("x");
      Object.defineProperty(response.headers, "set", {
        value: () => {
          throw new RangeError("not an immutability failure");
        },
      });
      return response;
    });

    const res = await app.request("/broken");
    expect(res.status).toBe(500);
  });
});

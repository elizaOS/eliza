import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  sendError,
  sendJson,
  sendServiceUnavailable,
} from "../api/route-utils.js";

/**
 * Minimal ServerResponse stand-in capturing writeHead/end so we can assert the
 * status code, headers, and serialized body without a live HTTP server.
 */
function createMockResponse(): {
  res: ServerResponse;
  statusCode: () => number | undefined;
  headers: () => Record<string, string>;
  body: () => string;
} {
  let statusCode: number | undefined;
  let headers: Record<string, string> = {};
  let body = "";
  const res = {
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) headers = { ...headers, ...hdrs };
      return this;
    },
    end(chunk?: string) {
      if (typeof chunk === "string") body += chunk;
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    statusCode: () => statusCode,
    headers: () => headers,
    body: () => body,
  };
}

describe("sendServiceUnavailable", () => {
  it("emits a 503 with Retry-After and a structured initializing body", () => {
    const mock = createMockResponse();
    sendServiceUnavailable(mock.res, "ACP service not available");

    expect(mock.statusCode()).toBe(503);
    expect(mock.headers()["Content-Type"]).toBe("application/json");
    // Retry-After is integer seconds per the HTTP spec, default 1s.
    expect(mock.headers()["Retry-After"]).toBe("1");

    const parsed = JSON.parse(mock.body());
    expect(parsed.error).toBe("ACP service not available");
    expect(parsed.status).toBe("initializing");
    expect(parsed.retryAfterMs).toBe(1000);
  });

  it("rounds sub-second retry hints up to one second for Retry-After", () => {
    const mock = createMockResponse();
    sendServiceUnavailable(mock.res, "still starting", 250);

    expect(mock.headers()["Retry-After"]).toBe("1");
    expect(JSON.parse(mock.body()).retryAfterMs).toBe(250);
  });

  it("ceils multi-second retry hints to whole seconds", () => {
    const mock = createMockResponse();
    sendServiceUnavailable(mock.res, "still starting", 2500);

    expect(mock.headers()["Retry-After"]).toBe("3");
    expect(JSON.parse(mock.body()).retryAfterMs).toBe(2500);
  });
});

describe("sendError / sendJson", () => {
  it("sendError keeps the legacy { error } shape with no Retry-After", () => {
    const mock = createMockResponse();
    sendError(mock.res, "Task not found", 404);

    expect(mock.statusCode()).toBe(404);
    expect(mock.headers()["Retry-After"]).toBeUndefined();
    const parsed = JSON.parse(mock.body());
    expect(parsed).toEqual({ error: "Task not found" });
    expect(parsed.status).toBeUndefined();
  });

  it("sendJson defaults to a 200 status", () => {
    const mock = createMockResponse();
    sendJson(mock.res, { ok: true });

    expect(mock.statusCode()).toBe(200);
    expect(JSON.parse(mock.body())).toEqual({ ok: true });
  });
});

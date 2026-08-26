/**
 * Verifies sendServiceUnavailable.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  parseBody,
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

function makeChunkedReq(chunks: Buffer[]): IncomingMessage {
  const stream = Readable.from(chunks);
  return Object.assign(stream, {
    method: "POST",
    url: "/test",
  }) as unknown as IncomingMessage;
}

describe("parseBody", () => {
  it("preserves a 4-byte emoji split across chunk boundaries", async () => {
    const bodyObj = { text: "hello \uD83C\uDF0F world" }; // 🌏 is 4-byte UTF-8: F0 9F 8C 8F
    const json = JSON.stringify(bodyObj);
    const buf = Buffer.from(json, "utf-8");
    // Split inside the emoji's 4-byte sequence: 2+2
    const emojiStart = buf.indexOf(Buffer.from("🌏", "utf-8"));
    const splitAt = emojiStart + 2;
    const c1 = buf.subarray(0, splitAt);
    const c2 = buf.subarray(splitAt);
    const req = makeChunkedReq([c1, c2]);
    const result = await parseBody(req);
    expect(result).toEqual(bodyObj);
  });

  it("preserves 3-byte CJK characters split across chunks", async () => {
    const bodyObj = { text: "\u4e2d\u6587\u6d4b\u8bd5" }; // 中文测试, each 3-byte
    const json = JSON.stringify(bodyObj);
    const buf = Buffer.from(json, "utf-8");
    // Split inside the second CJK character (3-byte: E6 96 87). Find start then +1
    const cjkStart = buf.indexOf(Buffer.from("文", "utf-8"));
    const splitAt = cjkStart + 1; // inside the character
    const c1 = buf.subarray(0, splitAt);
    const c2 = buf.subarray(splitAt);
    const req = makeChunkedReq([c1, c2]);
    const result = await parseBody(req);
    expect(result).toEqual(bodyObj);
  });

  it("preserves a single chunk containing multibyte without split", async () => {
    const bodyObj = { text: "café 🌟 naïve" };
    const json = JSON.stringify(bodyObj);
    const req = makeChunkedReq([Buffer.from(json, "utf-8")]);
    const result = await parseBody(req);
    expect(result).toEqual(bodyObj);
  });

  it("handles string chunks via Buffer conversion", async () => {
    const bodyObj = { text: "emoji 🌏 split via string chunks" };
    const json = JSON.stringify(bodyObj);
    // Provide as string chunks that would previously be concatenated per-chunk
    const stream = Readable.from([json.slice(0, 10), json.slice(10)]);
    const req = Object.assign(stream, {
      method: "POST",
      url: "/test",
    }) as unknown as IncomingMessage;
    // Override to emit strings not Buffers by setting encoding? Simpler: push string via Readable
    const result = await parseBody(req);
    expect(result).toEqual(bodyObj);
  });

  it("rejects invalid JSON", async () => {
    const req = makeChunkedReq([Buffer.from("{ not json", "utf-8")]);
    await expect(parseBody(req)).rejects.toThrow("Invalid JSON body");
  });

  it("returns empty object for empty body", async () => {
    const req = makeChunkedReq([]);
    const result = await parseBody(req);
    expect(result).toEqual({});
  });
});

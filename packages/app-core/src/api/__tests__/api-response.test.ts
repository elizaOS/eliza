import { describe, expect, it, vi } from "vitest";
import { sendJson, sendJsonError } from "./response.ts";

function mockRes() {
  return {
    headersSent: false,
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as never;
}

describe("sendJson", () => {
  it("writes status, content-type, and serialized body", () => {
    const res = mockRes();
    sendJson(res, 201, { ok: true });
    expect(res.statusCode).toBe(201);
    expect(res.setHeader).toHaveBeenCalledWith(
      "content-type",
      "application/json; charset=utf-8",
    );
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it("is a no-op once headers are sent", () => {
    const res = mockRes();
    res.headersSent = true;
    sendJson(res, 200, {});
    expect(res.end).not.toHaveBeenCalled();
  });

  it("strips stack traces from payloads", () => {
    const res = mockRes();
    const err = new Error("boom");
    err.stack = "at somewhere";
    sendJson(res, 500, { err, stack: "leaked" });
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.err).toEqual({ error: "boom" });
    expect(body.stack).toBeUndefined();
  });
});

describe("sendJsonError", () => {
  it("wraps the message as an error object", () => {
    const res = mockRes();
    sendJsonError(res, 400, "bad input");
    expect(res.statusCode).toBe(400);
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({ error: "bad input" }),
    );
  });
});

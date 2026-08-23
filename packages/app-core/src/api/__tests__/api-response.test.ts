import { describe, expect, it, vi } from "vitest";
import { sendJson, sendJsonError } from "../response.ts";

function mockRes() {
  return {
    headersSent: false,
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as import("node:http").ServerResponse;
}

describe("sendJson", () => {
  it("writes status, content-type, and json body", () => {
    const res = mockRes();
    sendJson(res, 200, { ok: true });
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "content-type",
      "application/json; charset=utf-8",
    );
    const body = JSON.parse(
      (res.end as ReturnType<typeof vi.fn>).mock.calls[0][0],
    );
    expect(body).toEqual({ ok: true });
  });

  it("strips stack traces from error payloads", () => {
    const res = mockRes();
    sendJson(res, 500, { err: new Error("boom") });
    const body = JSON.parse(
      (res.end as ReturnType<typeof vi.fn>).mock.calls[0][0],
    );
    expect(body).toEqual({ err: { error: "boom" } });
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("is a no-op once headers are sent", () => {
    const res = mockRes();
    res.headersSent = true;
    sendJson(res, 500, {});
    expect(res.end).not.toHaveBeenCalled();
  });
});

describe("sendJsonError", () => {
  it("wraps the message as an error object", () => {
    const res = mockRes();
    sendJsonError(res, 400, "bad request");
    const body = JSON.parse(
      (res.end as ReturnType<typeof vi.fn>).mock.calls[0][0],
    );
    expect(body).toEqual({ error: "bad request" });
    expect(res.statusCode).toBe(400);
  });
});

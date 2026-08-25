import { describe, expect, it, vi } from "vitest";
import { readJsonBody, sendJson, sendJsonError } from "./http.ts";

function makeRes() {
  return {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

function makeReq(chunks: Array<string | Buffer>, opts: { body?: unknown; destroy?: () => void } = {}) {
  const req: Record<string, unknown> = {
    body: opts.body,
    destroy: opts.destroy ?? vi.fn(),
  };
  req[Symbol.asyncIterator] = async function* () {
    for (const c of chunks) yield c;
  };
  return req;
}

describe("sendJson", () => {
  it("writes a JSON body with the given status and content-type", () => {
    const res = makeRes();
    sendJson(res as never, { ok: 1 }, 201);
    expect(res.statusCode).toBe(201);
    expect(res.setHeader).toHaveBeenCalledWith(
      "content-type",
      "application/json; charset=utf-8",
    );
    expect(res.end).toHaveBeenCalledWith('{"ok":1}');
  });

  it("defaults to status 200", () => {
    const res = makeRes();
    sendJson(res as never, { ok: 1 });
    expect(res.statusCode).toBe(200);
  });

  it("does nothing once headers are sent (no double-write)", () => {
    const res = makeRes();
    res.headersSent = true;
    sendJson(res as never, { ok: 1 });
    expect(res.end).not.toHaveBeenCalled();
  });

  it("scrubs Error objects to a message-only shape (no stack leak)", () => {
    const res = makeRes();
    sendJson(res as never, { error: new Error("boom") });
    const body = JSON.parse((res.end.mock.calls[0] as unknown[])[0] as string);
    expect(body).toEqual({ error: { error: "boom" } });
    expect(JSON.stringify(body)).not.toContain("at ");
  });

  it("recursively strips stack/stackTrace keys from nested objects and arrays", () => {
    const res = makeRes();
    sendJson(res as never, {
      list: [{ stack: "secret", stackTrace: "secret2", keep: 1 }],
      stack: "top-secret",
    });
    const body = JSON.parse((res.end.mock.calls[0] as unknown[])[0] as string);
    expect(body).toEqual({ list: [{ keep: 1 }] });
  });

  it("keeps plain primitives unchanged", () => {
    const res = makeRes();
    sendJson(res as never, { n: 42, s: "x", nil: null });
    const body = JSON.parse((res.end.mock.calls[0] as unknown[])[0] as string);
    expect(body).toEqual({ n: 42, s: "x", nil: null });
  });
});

describe("sendJsonError", () => {
  it("sends { error } with a 400 default", () => {
    const res = makeRes();
    sendJsonError(res as never, "bad");
    expect(res.statusCode).toBe(400);
    const body = JSON.parse((res.end.mock.calls[0] as unknown[])[0] as string);
    expect(body).toEqual({ error: "bad" });
  });

  it("accepts an explicit status", () => {
    const res = makeRes();
    sendJsonError(res as never, "nope", 403);
    expect(res.statusCode).toBe(403);
  });
});

describe("readJsonBody", () => {
  it("parses a valid JSON object and caches it on req.body", async () => {
    const res = makeRes();
    const req = makeReq(['{"a":1}']);
    const out = await readJsonBody(req as never, res as never);
    expect(out).toEqual({ a: 1 });
    expect(req.body).toEqual({ a: 1 });
    expect(res.end).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON with a 400 and returns null", async () => {
    const res = makeRes();
    const req = makeReq(["{oops"]);
    const out = await readJsonBody(req as never, res as never);
    expect(out).toBeNull();
    expect(res.statusCode).toBe(400);
    const body = JSON.parse((res.end.mock.calls[0] as unknown[])[0] as string);
    expect(body.error).toContain("Invalid JSON");
  });

  it("rejects non-object JSON bodies (array) with a 400", async () => {
    const res = makeRes();
    const req = makeReq(["[1,2,3]"]);
    const out = await readJsonBody(req as never, res as never);
    expect(out).toBeNull();
    expect(res.statusCode).toBe(400);
    const body = JSON.parse((res.end.mock.calls[0] as unknown[])[0] as string);
    expect(body.error).toBe("Request body must be a JSON object");
  });

  it("rejects an oversized body with a 413 before it can be buffered further", async () => {
    const res = makeRes();
    const req = makeReq(["1234567890"]);
    const out = await readJsonBody(req as never, res as never, { maxBytes: 5 });
    expect(out).toBeNull();
    expect(res.statusCode).toBe(413);
    const body = JSON.parse((res.end.mock.calls[0] as unknown[])[0] as string);
    expect(body.error).toContain("Request body too large");
  });

  it("destroys the request when destroyOnTooLarge is set", async () => {
    const res = makeRes();
    const destroy = vi.fn();
    const req = makeReq(["1234567890"], { destroy });
    await readJsonBody(req as never, res as never, {
      maxBytes: 3,
      destroyOnTooLarge: true,
    });
    expect(destroy).toHaveBeenCalled();
  });

  it("treats an empty body as an empty object and caches it", async () => {
    const res = makeRes();
    const req = makeReq([]);
    const out = await readJsonBody(req as never, res as never);
    expect(out).toEqual({});
    expect(req.body).toEqual({});
  });

  it("returns the cached body without consuming the stream", async () => {
    const res = makeRes();
    const req = makeReq([], { body: { cached: true } });
    const out = await readJsonBody(req as never, res as never);
    expect(out).toEqual({ cached: true });
    expect(res.end).not.toHaveBeenCalled();
  });

  it("rejects a cached non-object body with a 400", async () => {
    const res = makeRes();
    const req = makeReq([], { body: "nope" });
    const out = await readJsonBody(req as never, res as never);
    expect(out).toBeNull();
    expect(res.statusCode).toBe(400);
  });

  it("allows non-object bodies when requireObject is false", async () => {
    const res = makeRes();
    const req = makeReq(["[1,2]"]);
    const out = await readJsonBody(req as never, res as never, {
      requireObject: false,
    });
    expect(out).toEqual([1, 2]);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("propagates stream read failures as a 413", async () => {
    const res = makeRes();
    const req: Record<string, unknown> = { destroy: vi.fn() };
    req[Symbol.asyncIterator] = async function* () {
      throw new Error("socket hung up");
    };
    const out = await readJsonBody(req as never, res as never);
    expect(out).toBeNull();
    expect(res.statusCode).toBe(413);
    const body = JSON.parse((res.end.mock.calls[0] as unknown[])[0] as string);
    expect(body.error).toContain("socket hung up");
  });
});

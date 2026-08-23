/**
 * Colocated coverage for `sendJson` / `sendJsonError`. Drives the real helpers
 * through a real Node `http.Server` on an ephemeral loopback port and reads the
 * wire with `fetch` — no mocks of the module under test. Pins primitive/empty
 * bodies, the headers-already-sent no-op (including `sendJsonError` and a
 * second `sendJson` after the first has ended the response), stack-key
 * precedence over Error rendering, case-sensitive key matching, and the
 * `toJSON` → scrubber pass.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendJson, sendJsonError } from "./response.ts";

type Handler = (res: http.ServerResponse) => void;

let server: http.Server;
let baseUrl: string;
let handler: Handler = (res) => res.end();
let handlerError: unknown;

async function roundTrip(
  h: Handler,
): Promise<{ status: number; contentType: string | null; text: string }> {
  handler = h;
  handlerError = undefined;
  const response = await fetch(baseUrl);
  const text = await response.text();
  if (handlerError !== undefined) throw handlerError;
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    text,
  };
}

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    try {
      handler(res);
    } catch (error) {
      // error-policy:J1 test transport boundary: surface the handler failure
      // through roundTrip so the in-flight fetch does not hang.
      handlerError = error;
      if (!res.writableEnded) res.end();
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("sendJson", () => {
  it("writes status, JSON content-type, and a serialized object body", async () => {
    const out = await roundTrip((res) => sendJson(res, 201, { ok: true }));
    expect(out.status).toBe(201);
    expect(out.contentType).toBe("application/json; charset=utf-8");
    expect(out.text).toBe(JSON.stringify({ ok: true }));
  });

  it("serializes an empty object and an empty array as their JSON literals", async () => {
    const emptyObject = await roundTrip((res) => sendJson(res, 200, {}));
    expect(emptyObject.text).toBe("{}");
    const emptyArray = await roundTrip((res) => sendJson(res, 200, []));
    expect(emptyArray.text).toBe("[]");
  });

  it("serializes a single-element array without wrapping it in an object", async () => {
    const out = await roundTrip((res) => sendJson(res, 200, [{ id: 1 }]));
    expect(JSON.parse(out.text)).toEqual([{ id: 1 }]);
  });

  it("serializes null, false, 0, and an empty string as JSON primitives", async () => {
    const asNull = await roundTrip((res) => sendJson(res, 200, null));
    expect(asNull.text).toBe("null");
    const asFalse = await roundTrip((res) => sendJson(res, 200, false));
    expect(asFalse.text).toBe("false");
    const asZero = await roundTrip((res) => sendJson(res, 200, 0));
    expect(asZero.text).toBe("0");
    const asEmpty = await roundTrip((res) => sendJson(res, 200, ""));
    expect(asEmpty.text).toBe('""');
  });

  it("ends with an empty body when the root value is undefined", async () => {
    const out = await roundTrip((res) => sendJson(res, 204, undefined));
    expect(out.status).toBe(204);
    expect(out.contentType).toBe("application/json; charset=utf-8");
    expect(out.text).toBe("");
  });

  it("omits undefined object properties and renders NaN and Infinity as null", async () => {
    const out = await roundTrip((res) =>
      sendJson(res, 200, {
        keep: 1,
        drop: undefined,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
      }),
    );
    expect(JSON.parse(out.text)).toEqual({
      keep: 1,
      nan: null,
      inf: null,
    });
  });

  it("leaves status, headers, and body untouched once headers are sent", async () => {
    const out = await roundTrip((res) => {
      res.statusCode = 418;
      res.setHeader("content-type", "text/plain");
      res.write("already-started");
      expect(res.headersSent).toBe(true);
      sendJson(res, 200, { ok: true });
      expect(res.statusCode).toBe(418);
      expect(res.writableEnded).toBe(false);
      res.end();
    });
    expect(out.status).toBe(418);
    expect(out.contentType).toBe("text/plain");
    expect(out.text).toBe("already-started");
  });

  it("does not rewrite a completed response when sendJson is called a second time", async () => {
    const out = await roundTrip((res) => {
      sendJson(res, 201, { first: true });
      expect(res.headersSent).toBe(true);
      expect(res.writableEnded).toBe(true);
      sendJson(res, 500, { second: true });
    });
    expect(out.status).toBe(201);
    expect(JSON.parse(out.text)).toEqual({ first: true });
  });

  it("drops stack and stackTrace keys at any depth, including non-string values", async () => {
    const out = await roundTrip((res) =>
      sendJson(res, 200, {
        stack: "top-level",
        stackTrace: ["frame"],
        nested: { deep: { stack: 0, stackTrace: { frames: 1 }, keep: 1 } },
        list: [{ stackTrace: "x", id: 2 }],
      }),
    );
    expect(JSON.parse(out.text)).toEqual({
      nested: { deep: { keep: 1 } },
      list: [{ id: 2 }],
    });
  });

  it("does not drop a differently-cased Stack key", async () => {
    const out = await roundTrip((res) =>
      sendJson(res, 200, { Stack: "kept", stackTrace: "gone" }),
    );
    expect(JSON.parse(out.text)).toEqual({ Stack: "kept" });
  });

  it("drops a stack-keyed Error before rendering it as { error }", async () => {
    const secret = new Error("do-not-leak");
    secret.stack = "Error: do-not-leak\n    at secret (/srv/app.ts:1:1)";
    const out = await roundTrip((res) =>
      sendJson(res, 200, { stack: secret, keep: true }),
    );
    expect(JSON.parse(out.text)).toEqual({ keep: true });
    expect(out.text).not.toContain("do-not-leak");
    expect(out.text).not.toContain("secret");
  });

  it("renders Error values as { error: message } in objects and arrays", async () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at secret (/srv/app.ts:1:1)";
    const out = await roundTrip((res) =>
      sendJson(res, 500, { err, items: [new TypeError("bad type")] }),
    );
    expect(out.status).toBe(500);
    expect(JSON.parse(out.text)).toEqual({
      err: { error: "boom" },
      items: [{ error: "bad type" }],
    });
    expect(out.text).not.toContain("secret");
  });

  it("falls back to 'Internal error' for an Error with an empty message", async () => {
    const out = await roundTrip((res) => sendJson(res, 500, new Error("")));
    expect(JSON.parse(out.text)).toEqual({ error: "Internal error" });
  });

  it("keeps a whitespace-only Error message instead of substituting Internal error", async () => {
    const out = await roundTrip((res) => sendJson(res, 500, new Error("   ")));
    expect(JSON.parse(out.text)).toEqual({ error: "   " });
  });

  it("serializes values with toJSON (Date) through toJSON", async () => {
    const when = new Date("2026-01-02T03:04:05.000Z");
    const out = await roundTrip((res) => sendJson(res, 200, { when }));
    expect(JSON.parse(out.text)).toEqual({ when: "2026-01-02T03:04:05.000Z" });
  });

  it("scrubs stack keys on the object returned by a custom toJSON", async () => {
    const payload = {
      wrapped: {
        toJSON() {
          return { keep: "visible", stack: "hidden-frame" };
        },
      },
    };
    const out = await roundTrip((res) => sendJson(res, 200, payload));
    expect(JSON.parse(out.text)).toEqual({ wrapped: { keep: "visible" } });
  });

  it("propagates JSON.stringify failure on a circular body and does not hang", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await expect(
      roundTrip((res) => sendJson(res, 200, circular)),
    ).rejects.toThrow(/circular/i);
  });
});

describe("sendJsonError", () => {
  it("wraps the message as { error } with the given status", async () => {
    const out = await roundTrip((res) => sendJsonError(res, 400, "bad input"));
    expect(out.status).toBe(400);
    expect(out.contentType).toBe("application/json; charset=utf-8");
    expect(out.text).toBe(JSON.stringify({ error: "bad input" }));
  });

  it('preserves an empty error message as { error: "" }', async () => {
    const out = await roundTrip((res) => sendJsonError(res, 500, ""));
    expect(out.status).toBe(500);
    expect(JSON.parse(out.text)).toEqual({ error: "" });
  });

  it("preserves unicode in the error message", async () => {
    const out = await roundTrip((res) =>
      sendJsonError(res, 400, "bad: café 🔥"),
    );
    expect(JSON.parse(out.text)).toEqual({ error: "bad: café 🔥" });
  });

  it("is a no-op once headers are already sent", async () => {
    const out = await roundTrip((res) => {
      res.statusCode = 418;
      res.setHeader("content-type", "text/plain");
      res.write("started");
      sendJsonError(res, 500, "should-not-appear");
      expect(res.statusCode).toBe(418);
      expect(res.writableEnded).toBe(false);
      res.end();
    });
    expect(out.status).toBe(418);
    expect(out.contentType).toBe("text/plain");
    expect(out.text).toBe("started");
    expect(out.text).not.toContain("should-not-appear");
  });
});

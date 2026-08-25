/**
 * Pins the app-core JSON response helpers (`sendJson` / `sendJsonError`) from
 * `../response.ts`: status + `application/json` header + serialized body, the
 * no-op once headers are already sent, and the stack-scrubbing replacer
 * (`stack`/`stackTrace` keys dropped at any depth, Error values rendered as
 * `{ error: message }` with an `Internal error` fallback, `toJSON` values such
 * as Date passed through). Drives the real helpers through a real Node
 * `http.Server` on an ephemeral loopback port and reads the wire response with
 * `fetch` — no mocks.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendJson, sendJsonError } from "../response.js";

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
  // An assertion thrown inside the handler must fail the test instead of
  // hanging the client, so the server ends the response and we rethrow here.
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
  it("writes the status, JSON content-type, and serialized body", async () => {
    const out = await roundTrip((res) => sendJson(res, 201, { ok: true }));
    expect(out.status).toBe(201);
    expect(out.contentType).toBe("application/json; charset=utf-8");
    expect(out.text).toBe(JSON.stringify({ ok: true }));
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

  it("drops stack and stackTrace keys at any depth", async () => {
    const out = await roundTrip((res) =>
      sendJson(res, 200, {
        stack: "top-level",
        stackTrace: ["frame"],
        nested: { deep: { stack: "inner", keep: 1 } },
        list: [{ stackTrace: "x", id: 2 }],
      }),
    );
    expect(JSON.parse(out.text)).toEqual({
      nested: { deep: { keep: 1 } },
      list: [{ id: 2 }],
    });
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

  it("serializes values with toJSON (Date) through toJSON", async () => {
    const when = new Date("2026-01-02T03:04:05.000Z");
    const out = await roundTrip((res) => sendJson(res, 200, { when }));
    expect(JSON.parse(out.text)).toEqual({ when: "2026-01-02T03:04:05.000Z" });
  });
});

describe("sendJsonError", () => {
  it("wraps the message as { error } with the given status", async () => {
    const out = await roundTrip((res) => sendJsonError(res, 400, "bad input"));
    expect(out.status).toBe(400);
    expect(out.contentType).toBe("application/json; charset=utf-8");
    expect(out.text).toBe(JSON.stringify({ error: "bad input" }));
  });
});

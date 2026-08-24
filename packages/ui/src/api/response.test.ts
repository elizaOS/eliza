/**
 * Unit coverage for the shared HTTP JSON response helpers in
 * packages/ui/src/api/response.ts: status/content-type framing, the
 * stack-field scrub applied before serialization, Error-instance shaping,
 * and the headers-sent no-op guard. The node ServerResponse is a minimal
 * recorded double; the serialization and scrubbing under test are the real
 * module logic.
 */
import type http from "node:http";
import { describe, expect, it } from "vitest";
import { sendJson, sendJsonError } from "./response";

function makeRes() {
  const recorded: {
    headers: Record<string, string>;
    ended: boolean;
    bodies: string[];
  } = {
    headers: {},
    ended: false,
    bodies: [],
  };
  let headersSent = false;
  const res = {
    get headersSent() {
      return headersSent;
    },
    statusCode: 200,
    setHeader(name: string, value: string) {
      recorded.headers[name] = value;
    },
    end(body?: string) {
      recorded.ended = true;
      if (body !== undefined) recorded.bodies.push(body);
    },
  };
  return {
    res: res as unknown as http.ServerResponse,
    markHeadersSent() {
      headersSent = true;
    },
    status(): number {
      return (res as unknown as { statusCode: number }).statusCode;
    },
    recorded,
    lastBody(): Record<string, unknown> {
      expect(recorded.bodies).toHaveLength(1);
      return JSON.parse(recorded.bodies[0]) as Record<string, unknown>;
    },
  };
}

describe("sendJson", () => {
  it("writes the status code, JSON content type, and serialized body", () => {
    const { res, recorded, lastBody, status } = makeRes();
    sendJson(res, 201, { ok: true });
    expect(status()).toBe(201);
    expect(recorded.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(lastBody()).toEqual({ ok: true });
  });

  it("strips stack and stackTrace fields at every depth", () => {
    const { res, lastBody } = makeRes();
    sendJson(res, 500, {
      message: "boom",
      stack: "Error: boom\n    at top",
      detail: { stackTrace: "frames", keep: 1 },
      list: [{ stack: "inner" }],
    });
    const body = lastBody();
    expect(body.message).toBe("boom");
    expect(body.stack).toBeUndefined();
    const detail = body.detail as Record<string, unknown>;
    expect(detail.stackTrace).toBeUndefined();
    expect(detail.keep).toBe(1);
    const listItem = (body.list as Array<Record<string, unknown>>)[0];
    expect(listItem.stack).toBeUndefined();
  });

  it("shapes top-level Error instances into { error: message }", () => {
    const { res, lastBody } = makeRes();
    sendJson(res, 500, new Error("kaboom"));
    expect(lastBody()).toEqual({ error: "kaboom" });
  });

  it("falls back to a generic message for empty-error instances", () => {
    const { res, lastBody } = makeRes();
    sendJson(res, 500, new Error(""));
    expect(lastBody()).toEqual({ error: "Internal error" });
  });

  it("scrubs Error instances nested inside arrays and objects", () => {
    const { res, lastBody } = makeRes();
    sendJson(res, 200, [new Error("first"), { nested: new Error("second") }]);
    const body = lastBody();
    expect(body[0]).toEqual({ error: "first" });
    expect((body[1] as Record<string, unknown>).nested).toEqual({
      error: "second",
    });
  });

  it("is a no-op when headers were already sent", () => {
    const { res, recorded, markHeadersSent } = makeRes();
    markHeadersSent();
    sendJson(res, 500, { secret: "should not write" });
    expect(recorded.bodies).toHaveLength(0);
    expect(recorded.ended).toBe(false);
    expect(Object.keys(recorded.headers)).toHaveLength(0);
  });
});

describe("sendJsonError", () => {
  it("wraps the message into an { error } JSON payload", () => {
    const { res, recorded, lastBody, status } = makeRes();
    sendJsonError(res, 404, "not found");
    expect(status()).toBe(404);
    expect(recorded.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(lastBody()).toEqual({ error: "not found" });
  });

  it("stays silent after headers were sent", () => {
    const { res, recorded, markHeadersSent } = makeRes();
    markHeadersSent();
    sendJsonError(res, 400, "late failure");
    expect(recorded.bodies).toHaveLength(0);
    expect(recorded.ended).toBe(false);
  });
});

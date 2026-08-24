/**
 * Unit tests for UI HTTP JSON response helpers.
 * Validates sendJson, sendJsonError, stack trace sanitization, and headersSent guard.
 */

import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { sendJson, sendJsonError } from "../response.ts";

function createMockResponse(headersSent = false): {
  res: http.ServerResponse;
  headers: Record<string, string>;
  endBody: string;
} {
  const headers: Record<string, string> = {};
  let endBody = "";

  const res = {
    headersSent,
    statusCode: 200,
    setHeader: vi.fn((key: string, val: string) => {
      headers[key.toLowerCase()] = val;
    }),
    end: vi.fn((payload?: string) => {
      if (payload) endBody = payload;
    }),
  } as unknown as http.ServerResponse;

  return {
    res,
    headers,
    get endBody() {
      return endBody;
    },
  };
}

describe("api response helpers", () => {
  describe("sendJson", () => {
    it("sets status, content-type header, and writes JSON payload", () => {
      const mock = createMockResponse();
      const res = mock.res;
      const headers = mock.headers;
      sendJson(res, 200, { ok: true, data: "hello" });

      expect(res.statusCode).toBe(200);
      expect(headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(JSON.parse(mock.endBody)).toEqual({
        ok: true,
        data: "hello",
      });
    });

    it("scrubs stack and stackTrace fields from objects and nested structures", () => {
      const mock = createMockResponse();
      const res = mock.res;
      const body = {
        status: "error",
        stack: "Error: at foo.ts:10",
        stackTrace: "trace-info",
        details: {
          nested: "value",
          stack: "inner stack",
        },
        list: [
          { id: 1, stack: "item stack" },
          new Error("Nested error message"),
        ],
      };

      sendJson(res, 500, body);
      const parsed = JSON.parse(mock.endBody);

      expect(parsed.stack).toBeUndefined();
      expect(parsed.stackTrace).toBeUndefined();
      expect(parsed.details.stack).toBeUndefined();
      expect(parsed.details.nested).toBe("value");
      expect(parsed.list[0].stack).toBeUndefined();
      expect(parsed.list[1]).toEqual({ error: "Nested error message" });
    });

    it("does not write if headersSent is true", () => {
      const mock = createMockResponse(true);
      const res = mock.res;
      sendJson(res, 200, { ok: true });

      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });
  });

  describe("sendJsonError", () => {
    it("sends structured error message with status", () => {
      const mock = createMockResponse();
      const res = mock.res;
      sendJsonError(res, 404, "Resource not found");

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(mock.endBody)).toEqual({
        error: "Resource not found",
      });
    });
  });
});

/**
 * Route-level coverage for the raw database query read-only guard. The DATABASE
 * action has its own helper tests; this file pins the HTTP route copy so a
 * rejection sends a JSON response instead of silently returning from the handler.
 */

import type http from "node:http";
import { PassThrough } from "node:stream";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleDatabaseRoute } from "./database.ts";

function jsonPost(body: unknown): http.IncomingMessage {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  req.push(JSON.stringify(body));
  req.push(null);
  return req;
}

type RecordedResponse = http.ServerResponse & {
  body: string;
  headers: Record<string, string | number | readonly string[]>;
};

function responseRecorder(): RecordedResponse {
  return {
    statusCode: 200,
    body: "",
    headers: {},
    setHeader(
      this: RecordedResponse,
      name: string,
      value: string | number | readonly string[],
    ) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(this: RecordedResponse, chunk?: unknown) {
      if (chunk !== undefined) this.body += String(chunk);
      return this;
    },
  } as unknown as RecordedResponse;
}

describe("POST /api/database/query read-only guard", () => {
  it("rejects unicode-escaped identifiers with a JSON error before query execution", async () => {
    const query = vi.fn();
    const runtime = {
      adapter: {
        db: { query },
      },
    } as unknown as AgentRuntime;
    const res = responseRecorder();

    await expect(
      handleDatabaseRoute(
        jsonPost({
          sql: `SELECT U&"s\\0065tval"('s', 999)`,
          readOnly: true,
        }),
        res,
        runtime,
        "/api/database/query",
      ),
    ).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Query rejected: Unicode-escaped identifiers (U&"...") are not allowed in read-only mode: they can hide a dangerous function name from the guard.',
    });
    expect(query).not.toHaveBeenCalled();
  });
});

/**
 * Route-level coverage for database connection-test failures. Driver exception
 * text may contain SQL, credentials, or server paths and must stay in logs.
 */
import type http from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const marker = "<script>password=secret /srv/postgres.ts:42</script>";

vi.mock("pg", () => ({
  default: {
    Pool: class {
      async connect(): Promise<never> {
        throw new Error(marker);
      }

      async end(): Promise<void> {}
    },
  },
}));

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

describe("POST /api/database/test error boundary", () => {
  it("returns a stable failure instead of driver exception text", async () => {
    const res = responseRecorder();

    await expect(
      handleDatabaseRoute(
        jsonPost({
          connectionString: "postgres://user:password@127.0.0.1:5432/database",
        }),
        res,
        null,
        "/api/database/test",
      ),
    ).resolves.toBe(true);

    expect(JSON.parse(res.body)).toMatchObject({
      success: false,
      error: "Database connection failed",
    });
    expect(res.body).not.toContain(marker);
  });
});

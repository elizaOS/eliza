/**
 * Exercises database-table path decoding through the production route handler.
 * Invalid encodings must return a static 400 before Drizzle execution; valid
 * encodings must reach table lookup exactly once.
 */
import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleDatabaseRoute } from "./database.ts";

const MALFORMED_COMPONENTS = [
  "%",
  "%2",
  "%ZZ",
  "%E0%A4",
  "%ED%A0%80",
  "%C0%80",
] as const;

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

async function requestRows(tableComponent: string): Promise<{
  execute: ReturnType<typeof vi.fn>;
  handled: boolean;
  res: RecordedResponse;
}> {
  const pathname = `/api/database/tables/${tableComponent}/rows`;
  const execute = vi.fn().mockResolvedValue({ rows: [], fields: [] });
  const runtime = {
    adapter: { db: { execute } },
  } as unknown as AgentRuntime;
  const req = {
    method: "GET",
    url: pathname,
    headers: { host: "localhost" },
  } as unknown as http.IncomingMessage;
  const res = responseRecorder();

  const handled = await handleDatabaseRoute(req, res, runtime, pathname);
  return { execute, handled, res };
}

describe("database table path-component decoding", () => {
  for (const malformed of MALFORMED_COMPONENTS) {
    it(`rejects ${malformed} before database execution`, async () => {
      const { execute, handled, res } = await requestRows(malformed);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        error: "Invalid database table name: malformed URL encoding",
      });
      expect(execute).not.toHaveBeenCalled();
    });
  }

  it("decodes a valid table component before lookup", async () => {
    const { execute, handled, res } = await requestRows("%61");

    expect(handled).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Table "a" not found' });
  });

  it("does not decode an encoded percent sequence twice", async () => {
    const { execute, res } = await requestRows("%2561");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Table "%61" not found' });
  });

  it("decodes an encoded slash only after route matching", async () => {
    const { execute, res } = await requestRows("%2F");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Table "/" not found' });
  });
});

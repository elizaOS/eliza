import type http from "node:http";

import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { handleDatabaseRoute } from "./database.js";

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function makeRes(): {
  res: http.ServerResponse;
  capture: CapturedResponse;
  done: Promise<void>;
} {
  const capture: CapturedResponse = {
    statusCode: 200,
    headers: {},
    body: "",
  };
  let resolve: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      capture.headers[name] = value;
    },
    end(payload?: string) {
      capture.statusCode = (this as { statusCode: number }).statusCode;
      capture.body = payload ?? "";
      resolve();
    },
    headersSent: false,
  } as unknown as http.ServerResponse;
  return { res, capture, done };
}

function makeReq(params: {
  method: string;
  url: string;
  body?: unknown;
}): http.IncomingMessage {
  const bodyString =
    params.body !== undefined ? JSON.stringify(params.body) : "";
  let consumed = false;
  const req = {
    method: params.method,
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(bodyString)),
    },
    url: params.url,
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (consumed) return req;
      if (event === "data" && bodyString) {
        cb(Buffer.from(bodyString, "utf8"));
      } else if (event === "end") {
        consumed = true;
        cb();
      }
      return req;
    },
    off() {
      return req;
    },
  } as unknown as http.IncomingMessage;
  return req;
}

function makeRuntime(opts: {
  embedding: number[] | null;
  matches: Memory[];
}): AgentRuntime {
  return {
    useModel: vi.fn(async () => opts.embedding),
    searchMemories: vi.fn(async () => opts.matches),
    adapter: {} as unknown,
  } as unknown as AgentRuntime;
}

describe("GET/POST /api/database/vectors/search", () => {
  it("rejects requests with no query (400)", async () => {
    const runtime = makeRuntime({ embedding: [0.1, 0.2], matches: [] });
    const { res, capture, done } = makeRes();
    const req = makeReq({
      method: "GET",
      url: "/api/database/vectors/search",
    });

    const handled = await handleDatabaseRoute(
      req,
      res,
      runtime,
      "/api/database/vectors/search",
    );
    await done;
    expect(handled).toBe(true);
    expect(capture.statusCode).toBe(400);
    const body = JSON.parse(capture.body) as { error?: string };
    expect(body.error).toMatch(/query is required/);
  });

  it("rejects an unsupported table (400)", async () => {
    const runtime = makeRuntime({ embedding: [0.1, 0.2], matches: [] });
    const { res, capture, done } = makeRes();
    const req = makeReq({
      method: "GET",
      url: "/api/database/vectors/search?query=hello&table=evil",
    });

    await handleDatabaseRoute(
      req,
      res,
      runtime,
      "/api/database/vectors/search",
    );
    await done;
    expect(capture.statusCode).toBe(400);
    const body = JSON.parse(capture.body) as { error?: string };
    expect(body.error).toMatch(/not searchable/);
  });

  it("returns 500 when the embedding model returns an empty vector", async () => {
    const runtime = makeRuntime({ embedding: [], matches: [] });
    const { res, capture, done } = makeRes();
    const req = makeReq({
      method: "GET",
      url: "/api/database/vectors/search?query=hello",
    });

    await handleDatabaseRoute(
      req,
      res,
      runtime,
      "/api/database/vectors/search",
    );
    await done;
    expect(capture.statusCode).toBe(500);
  });

  it("calls runtime.searchMemories with the embedded query and shapes results", async () => {
    const matches = [
      {
        id: "11111111-2222-3333-4444-555555555555" as UUID,
        roomId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID,
        entityId: "ffffffff-0000-1111-2222-333333333333" as UUID,
        agentId: "aaaaaaaa-1111-2222-3333-444444444444" as UUID,
        content: { text: "first hit" },
        createdAt: 1700,
        similarity: 0.91,
      } as Memory & { similarity: number },
    ];
    const runtime = makeRuntime({ embedding: [0.1, 0.2, 0.3], matches });
    const { res, capture, done } = makeRes();
    const req = makeReq({
      method: "POST",
      url: "/api/database/vectors/search",
      body: { query: "birthday plans", limit: 5, table: "messages" },
    });

    await handleDatabaseRoute(
      req,
      res,
      runtime,
      "/api/database/vectors/search",
    );
    await done;

    expect(capture.statusCode).toBe(200);
    const body = JSON.parse(capture.body) as {
      query: string;
      table: string;
      count: number;
      results: Array<{ text: string; similarity: number | null }>;
    };
    expect(body.query).toBe("birthday plans");
    expect(body.table).toBe("messages");
    expect(body.count).toBe(1);
    expect(body.results[0].text).toBe("first hit");
    expect(body.results[0].similarity).toBe(0.91);

    const search = runtime.searchMemories as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(search).toHaveBeenCalledTimes(1);
    const callArg = search.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(callArg.tableName).toBe("messages");
    expect(callArg.limit).toBe(5);
  });
});

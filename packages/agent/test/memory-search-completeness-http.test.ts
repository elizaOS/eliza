/** Hash-memory search and quick context through the real route and file-backed SQLite. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  ChannelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, expect, it } from "vitest";
import {
  HASH_MEMORY_SOURCE,
  handleMemoryRoutes,
  type MemoryRouteContext,
} from "../src/api/memory-routes.ts";

const AGENT_NAME = "Memory search completeness";
const SCAN_LIMIT = 2000;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createRuntime(): Promise<AgentRuntime> {
  const directory = await mkdtemp(path.join(tmpdir(), "memory-search-http-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const runtime = new AgentRuntime({
    agentId: randomUUID() as UUID,
    character: { name: AGENT_NAME, bio: [], settings: {} },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      path.join(directory, "agent.sqlite"),
      runtime.agentId,
    ),
  );
  await runtime.init();
  cleanups.push(() => runtime.close());
  return runtime;
}

interface RouteReply {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

async function get(runtime: AgentRuntime, target: string): Promise<RouteReply> {
  const url = new URL(target, "http://localhost");
  const reply: RouteReply = { status: 0, body: undefined, headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      reply.headers[name] = value;
    },
  } as unknown as http.ServerResponse;
  const handled = await handleMemoryRoutes({
    req: {} as http.IncomingMessage,
    res,
    method: "GET",
    pathname: url.pathname,
    url,
    runtime,
    agentName: AGENT_NAME,
    json: (_res: unknown, data: unknown, status = 200) => {
      reply.status = status;
      reply.body = data;
    },
    error: (_res: unknown, message: string, status = 500) => {
      reply.status = status;
      reply.body = { error: message };
    },
    readJsonBody: async () => null,
  } as unknown as MemoryRouteContext);
  expect(handled).toBe(true);
  return reply;
}

async function saveNotes(runtime: AgentRuntime, count: number): Promise<void> {
  const roomId = stringToUuid(`${AGENT_NAME}-hash-memory-room`) as UUID;
  await runtime.createMemories(
    Array.from({ length: count }, (_unused, index) => ({
      tableName: "messages",
      memory: {
        id: randomUUID() as UUID,
        roomId,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        createdAt: index + 1,
        content: {
          // The oldest row holds the only match, so a scan that keeps just the
          // newest rows would report it as not found.
          text: index === 0 ? "the lighthouse keeper" : `filler note ${index}`,
          source: HASH_MEMORY_SOURCE,
          channelType: ChannelType.DM,
        },
      },
    })),
  );
}

it("searches every note while the room is within the scan limit", async () => {
  const runtime = await createRuntime();
  // The first request creates the hash-memory room the notes are written to.
  await get(runtime, "/api/memory/search?q=lighthouse");
  await saveNotes(runtime, SCAN_LIMIT);

  const reply = await get(runtime, "/api/memory/search?q=lighthouse");

  expect(reply.status).toBe(200);
  expect(reply.body).toMatchObject({
    count: 1,
    results: [{ text: "the lighthouse keeper" }],
  });
});

it("rejects a search that cannot cover every saved note", async () => {
  const runtime = await createRuntime();
  await get(runtime, "/api/memory/search?q=lighthouse");
  await saveNotes(runtime, SCAN_LIMIT + 1);

  await expect(
    get(runtime, "/api/memory/search?q=lighthouse"),
  ).rejects.toMatchObject({
    code: "MEMORY_SEARCH_SCAN_LIMIT",
    context: { rowCount: SCAN_LIMIT + 1, limit: SCAN_LIMIT },
  });
});

it("answers 503 for quick context when the documents service did not load", async () => {
  const previous = process.env.DOCUMENTS_SERVICE_TIMEOUT_MS;
  process.env.DOCUMENTS_SERVICE_TIMEOUT_MS = "50";
  cleanups.push(async () => {
    if (previous === undefined) delete process.env.DOCUMENTS_SERVICE_TIMEOUT_MS;
    else process.env.DOCUMENTS_SERVICE_TIMEOUT_MS = previous;
  });
  // This runtime registers no documents plugin, so the loader times out.
  const runtime = await createRuntime();

  const reply = await get(runtime, "/api/context/quick?q=anything");

  expect(reply.status).toBe(503);
  expect(reply.body).toEqual({
    error: "Documents service is still loading. Please retry shortly.",
  });
  expect(reply.headers["Retry-After"]).toBe("5");
});

/**
 * Real-PGlite route proof for hash-memory tenant isolation and legacy-room
 * compatibility. Two runtimes deliberately share one character name and one
 * database while the HTTP boundary reads old name-derived rows and writes the
 * stable agent-ID-derived namespace.
 */

import { PGlite } from "@electric-sql/pglite";
import {
  type AgentRuntime,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MemoryRouteContext } from "./memory-routes.ts";
import {
  HASH_MEMORY_SOURCE,
  handleMemoryRoutes,
  invalidateMemorySearchCache,
} from "./memory-routes.ts";

const FIRST_AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const SECOND_AGENT = "22222222-2222-4222-8222-222222222222" as UUID;
const SHARED_NAME = "Twin";

type StoredRow = {
  id: string;
  agent_id: string | null;
  entity_id: string;
  room_id: string;
  text: string;
  source: string;
  created_at: number | string;
};

function memoryFromRow(row: StoredRow): Memory {
  return {
    id: row.id as UUID,
    agentId: (row.agent_id ?? undefined) as UUID | undefined,
    entityId: row.entity_id as UUID,
    roomId: row.room_id as UUID,
    createdAt: Number(row.created_at),
    content: { text: row.text, source: row.source },
  } as Memory;
}

function makeRuntime(database: PGlite, agentId: UUID): AgentRuntime {
  return {
    agentId,
    character: { name: SHARED_NAME },
    ensureConnection: vi.fn(async () => undefined),
    getMemories: vi.fn(
      async (params: {
        roomId?: UUID;
        agentId?: UUID;
        entityId?: UUID;
        limit?: number;
      }) => {
        const predicates = ["room_id = $1"];
        const values: Array<string | number> = [params.roomId ?? ""];
        if (params.agentId) {
          values.push(params.agentId);
          predicates.push(`agent_id = $${values.length}`);
        }
        if (params.entityId) {
          values.push(params.entityId);
          predicates.push(`entity_id = $${values.length}`);
        }
        values.push(params.limit ?? 2_000);
        const rows = await database.query<StoredRow>(
          `SELECT * FROM hash_memories WHERE ${predicates.join(
            " AND ",
          )} ORDER BY created_at DESC LIMIT $${values.length}`,
          values,
        );
        return rows.rows.map(memoryFromRow);
      },
    ),
    countMemories: vi.fn(
      async (params: { roomId?: UUID; agentId?: UUID; entityId?: UUID }) => {
        const predicates = ["room_id = $1"];
        const values: string[] = [params.roomId ?? ""];
        if (params.agentId) {
          values.push(params.agentId);
          predicates.push(`agent_id = $${values.length}`);
        }
        if (params.entityId) {
          values.push(params.entityId);
          predicates.push(`entity_id = $${values.length}`);
        }
        const result = await database.query<{ total: number | string }>(
          `SELECT count(*) AS total FROM hash_memories WHERE ${predicates.join(
            " AND ",
          )}`,
          values,
        );
        return Number(result.rows[0]?.total);
      },
    ),
    createMemory: vi.fn(async (memory: Memory) => {
      await database.query(
        `INSERT INTO hash_memories
          (id, agent_id, entity_id, room_id, text, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          memory.id as string,
          memory.agentId ?? null,
          memory.entityId,
          memory.roomId,
          memory.content.text ?? "",
          memory.content.source ?? "",
          memory.createdAt ?? Date.now(),
        ],
      );
      return memory.id as UUID;
    }),
    getMemoryById: vi.fn(async (id: UUID) => {
      const result = await database.query<StoredRow>(
        "SELECT * FROM hash_memories WHERE id = $1",
        [id],
      );
      const row = result.rows[0];
      return row ? memoryFromRow(row) : null;
    }),
    reportError: vi.fn(() => undefined),
  } as unknown as AgentRuntime;
}

function routeContext(
  runtime: AgentRuntime,
  path: string,
  response: { value?: unknown },
  method = "GET",
  body: Record<string, unknown> = {},
): MemoryRouteContext {
  return {
    req: {} as never,
    res: {} as never,
    method,
    pathname: path.split("?")[0] ?? path,
    url: new URL(`https://agent.test${path}`),
    runtime,
    agentName: SHARED_NAME,
    json: (_res, value) => {
      response.value = value;
    },
    error: (_res, message, status) => {
      throw new Error(`unexpected ${status}: ${message}`);
    },
    readJsonBody: async <T extends object>() => body as T,
  };
}

async function search(runtime: AgentRuntime, query: string): Promise<string[]> {
  const response: { value?: unknown } = {};
  await handleMemoryRoutes(
    routeContext(
      runtime,
      `/api/memory/search?q=${encodeURIComponent(query)}`,
      response,
    ),
  );
  return (response.value as { results: Array<{ text: string }> }).results.map(
    (result) => result.text,
  );
}

async function remember(runtime: AgentRuntime, text: string): Promise<void> {
  const response: { value?: unknown } = {};
  await handleMemoryRoutes(
    routeContext(runtime, "/api/memory/remember", response, "POST", { text }),
  );
  expect(response.value).toEqual(expect.objectContaining({ ok: true }));
}

describe("hash-memory tenant namespace", () => {
  let database: PGlite | null = null;

  afterEach(async () => {
    invalidateMemorySearchCache();
    if (database) await database.close();
    database = null;
  });

  test("same-name runtimes cannot read each other's legacy or current notes", async () => {
    database = new PGlite();
    await database.exec(`
      CREATE TABLE hash_memories (
        id text PRIMARY KEY,
        agent_id text,
        entity_id text NOT NULL,
        room_id text NOT NULL,
        text text NOT NULL,
        source text NOT NULL,
        created_at bigint NOT NULL
      )
    `);

    const firstRuntime = makeRuntime(database, FIRST_AGENT);
    const secondRuntime = makeRuntime(database, SECOND_AGENT);
    const legacyRoomId = stringToUuid(
      `${SHARED_NAME}-hash-memory-room`,
    ) as UUID;

    await database.query(
      `INSERT INTO hash_memories
        (id, agent_id, entity_id, room_id, text, source, created_at)
       VALUES ($1, NULL, $2, $3, $4, $5, 1),
              ($6, NULL, $7, $3, $8, $5, 2)`,
      [
        "aaaaaaaa-0000-4000-8000-000000000001",
        FIRST_AGENT,
        legacyRoomId,
        "first private albatross",
        HASH_MEMORY_SOURCE,
        "bbbbbbbb-0000-4000-8000-000000000001",
        SECOND_AGENT,
        "second private kestrel",
      ],
    );

    expect(await search(firstRuntime, "private")).toEqual([
      "first private albatross",
    ]);
    expect(await search(secondRuntime, "private")).toEqual([
      "second private kestrel",
    ]);

    await remember(firstRuntime, "first current puffin");
    await remember(secondRuntime, "second current heron");
    expect(await search(firstRuntime, "current")).toEqual([
      "first current puffin",
    ]);
    expect(await search(secondRuntime, "current")).toEqual([
      "second current heron",
    ]);

    const firstStableRoom = stringToUuid(
      `${HASH_MEMORY_SOURCE}:${FIRST_AGENT}:room:v2`,
    ) as UUID;
    const secondStableRoom = stringToUuid(
      `${HASH_MEMORY_SOURCE}:${SECOND_AGENT}:room:v2`,
    ) as UUID;
    expect(firstStableRoom).not.toBe(secondStableRoom);

    const stored = await database.query<StoredRow>(
      "SELECT * FROM hash_memories WHERE agent_id IS NOT NULL ORDER BY text",
    );
    expect(stored.rows).toEqual([
      expect.objectContaining({
        agent_id: FIRST_AGENT,
        entity_id: FIRST_AGENT,
        room_id: firstStableRoom,
        text: "first current puffin",
      }),
      expect.objectContaining({
        agent_id: SECOND_AGENT,
        entity_id: SECOND_AGENT,
        room_id: secondStableRoom,
        text: "second current heron",
      }),
    ]);
  }, 30_000);
});

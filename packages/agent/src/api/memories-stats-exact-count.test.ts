/**
 * Exercises GET /api/memories/stats at the real route boundary against a real
 * InMemoryDatabaseAdapter, pinning the exact-count invariant: the route must
 * report true per-table counts even past any fetch window, never a capped
 * getMemories(limit).length, and must signal exactness like its sibling
 * browse/by-entity routes signal inexactness.
 */

import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../core/src/database/inMemoryAdapter.ts";
import {
  handleMemoryRoutes,
  MEMORY_TABLE_NAMES,
  type MemoryRouteContext,
} from "./memory-routes.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const OTHER_AGENT = "00000000-0000-0000-0000-0000000000c2" as UUID;

function makeRuntime(adapter: InMemoryDatabaseAdapter): AgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    async ensureConnection() {
      /* connection bookkeeping is irrelevant to the count invariant */
    },
    getMemories(params: Parameters<InMemoryDatabaseAdapter["getMemories"]>[0]) {
      return adapter.getMemories(params);
    },
    countMemories(
      params: Parameters<InMemoryDatabaseAdapter["countMemories"]>[0],
    ) {
      return adapter.countMemories(params);
    },
  } as unknown as AgentRuntime;
}

async function insertMessages(
  adapter: InMemoryDatabaseAdapter,
  count: number,
  agentId: UUID = AGENT_ID,
): Promise<void> {
  const batch = Array.from({ length: count }, (_, i) => {
    const memory = {
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` as UUID,
      entityId: "22222222-2222-4222-8222-222222222222" as UUID,
      roomId: "44444444-4444-4444-8444-444444444444" as UUID,
      agentId,
      createdAt: 2_000_000 - i,
      content: { text: `note ${i}` },
    } satisfies Partial<Memory> as Memory;
    return { memory, tableName: "messages" };
  });
  await adapter.createMemories(batch);
}

async function stats(runtime: AgentRuntime): Promise<{
  total: number;
  byType: Record<string, number>;
  totalIsExact?: boolean;
}> {
  let output: unknown;
  const context: MemoryRouteContext = {
    req: {} as never,
    res: {} as never,
    method: "GET",
    pathname: "/api/memories/stats",
    url: new URL("https://agent.test/api/memories/stats"),
    runtime,
    agentName: "Eliza",
    json: (_res, value) => {
      output = value;
    },
    error: (_res, message, status) => {
      throw new Error(`unexpected ${status}: ${message}`);
    },
    readJsonBody: async <T extends object>() => ({}) as T,
  };
  const handled = await handleMemoryRoutes(context);
  if (!handled) throw new Error("stats route not handled");
  return output as {
    total: number;
    byType: Record<string, number>;
    totalIsExact?: boolean;
  };
}

describe("GET /api/memories/stats", () => {
  it("counts exactly past the previous 10,000-row fetch cap", async () => {
    const adapter = new InMemoryDatabaseAdapter();
    await insertMessages(adapter, 10_050);

    const body = await stats(makeRuntime(adapter));

    expect(body.byType.messages).toBe(10_050);
    expect(body.total).toBe(10_050);
  });

  it("reports identical totals to the origin implementation on sub-cap corpora", async () => {
    // No-over-rejection corpus: mixed tables and a foreign-agent partition,
    // all under the old 10,000 fetch cap where both implementations must
    // agree with the store's ground truth.
    const adapter = new InMemoryDatabaseAdapter();
    await insertMessages(adapter, 137);
    await insertMessages(adapter, 23, OTHER_AGENT);
    await adapter.createMemories([
      {
        memory: {
          id: "00000000-0000-4000-8000-000000099999" as UUID,
          entityId: "22222222-2222-4222-8222-222222222222" as UUID,
          roomId: "44444444-4444-4444-8444-444444444444" as UUID,
          agentId: AGENT_ID,
          createdAt: 1_000_000,
          content: { text: "fact" },
        } satisfies Partial<Memory> as Memory,
        tableName: "facts",
      },
    ]);

    const body = await stats(makeRuntime(adapter));

    const groundTruth = await adapter.countMemories({
      agentId: AGENT_ID,
      tableName: "messages",
    });
    expect(groundTruth).toBe(137);
    // The old implementation returned memories.length for
    // getMemories({limit:10000}) — identical on every sub-cap corpus.
    expect(body.byType.messages).toBe(137);
    expect(body.byType.facts).toBe(1);
    for (const table of MEMORY_TABLE_NAMES) {
      const exact = await adapter.countMemories({
        agentId: AGENT_ID,
        tableName: table,
      });
      expect(body.byType[table]).toBe(exact);
    }
    expect(body.total).toBe(
      MEMORY_TABLE_NAMES.reduce(
        (sum, table) => sum + (body.byType[table] ?? 0),
        0,
      ),
    );
  });

  it("signals exactness explicitly like sibling browse routes signal inexactness", async () => {
    const adapter = new InMemoryDatabaseAdapter();
    await insertMessages(adapter, 3);

    const body = await stats(makeRuntime(adapter));
    expect(body.totalIsExact).toBe(true);
  });
});

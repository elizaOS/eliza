/**
 * Deterministic scripted-executor tests for the shared_agent_memories
 * repository. Mirrors the shared-runtime-history capture pattern: the drizzle
 * chain is mocked, the generated WHERE clauses are rendered through PgDialect,
 * and every query is pinned to carry organization_id (plus user_id/agent_id)
 * so a cross-tenant read or write can never land silently. Real-database
 * behavior is covered by shared-agent-memories.integration.test.ts.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as realClient from "../client";

const ORG_A = "5a5c62c4-51b6-4e94-8c4e-a41d62b85e2f";
const USER_A = "9a3d9f2e-97ab-46be-a687-3a4f2f6bfa53";
const AGENT_A = "3b7fbe62-9a41-4d3e-9dc7-2b6d51a1c9d1";
const ROOM_A = "b3b46d54-6b3f-4f1e-9137-9a5763a4b911";
const MEMORY_ID = "0f2c94a1-6dbe-4f80-b1de-5a4f5f4f4242";

const scope = { organizationId: ORG_A, userId: USER_A, agentId: AGENT_A };

function renderedWhere(clause: SQL | undefined): { sql: string; params: unknown[] } {
  if (!clause) throw new Error("WHERE clause was not captured");
  return new PgDialect().sqlToQuery(clause);
}

function expectTenantPins(clause: SQL | undefined): void {
  const rendered = renderedWhere(clause);
  expect(rendered.sql).toContain("organization_id");
  expect(rendered.sql).toContain("user_id");
  expect(rendered.sql).toContain("agent_id");
  expect(rendered.params).toContain(ORG_A);
  expect(rendered.params).toContain(USER_A);
  expect(rendered.params).toContain(AGENT_A);
}

afterAll(() => {
  mock.module("../client", () => realClient);
});

describe("SharedAgentMemoriesReader.listRecentByRoom", () => {
  test("pins organization, user, agent, and room in WHERE and caps the read", async () => {
    let capturedWhere: SQL | undefined;
    let capturedLimit: number | undefined;
    const rows = [{ id: MEMORY_ID }];
    const limitFn = mock((limit: number) => {
      capturedLimit = limit;
      return Promise.resolve(rows);
    });
    const orderByFn = mock(() => ({ limit: limitFn }));
    const whereFn = mock((clause: SQL) => {
      capturedWhere = clause;
      return { orderBy: orderByFn };
    });
    const fromFn = mock(() => ({ where: whereFn }));
    const selectFn = mock(() => ({ from: fromFn }));
    const dbReadMock = new Proxy(realClient.dbRead as unknown as Record<PropertyKey, unknown>, {
      get(target, prop, receiver) {
        if (prop === "select") return selectFn;
        return Reflect.get(target, prop, receiver);
      },
    });
    mock.module("../client", () => ({ ...realClient, dbRead: dbReadMock }));
    try {
      const { SharedAgentMemoriesReader } = await import("./shared-agent-memories");
      const result = await new SharedAgentMemoriesReader().listRecentByRoom(scope, ROOM_A, 25);
      expect(result).toEqual(rows as never);
      expect(capturedLimit).toBe(25);
      expectTenantPins(capturedWhere);
      const rendered = renderedWhere(capturedWhere);
      expect(rendered.sql).toContain("room_id");
      expect(rendered.params).toContain(ROOM_A);
    } finally {
      mock.module("../client", () => realClient);
    }
  });

  test("rejects an unbounded or invalid limit before touching the database", async () => {
    const { SharedAgentMemoriesReader } = await import("./shared-agent-memories");
    const reader = new SharedAgentMemoriesReader();
    await expect(reader.listRecentByRoom(scope, ROOM_A, 0)).rejects.toThrow(
      "positive integer within bounds",
    );
    await expect(reader.listRecentByRoom(scope, ROOM_A, 10_000)).rejects.toThrow(
      "positive integer within bounds",
    );
    await expect(reader.listRecentByRoom(scope, ROOM_A, 2.5)).rejects.toThrow(
      "positive integer within bounds",
    );
  });

  test("rejects an incomplete tenant scope", async () => {
    const { SharedAgentMemoriesReader } = await import("./shared-agent-memories");
    await expect(
      new SharedAgentMemoriesReader().listRecentByRoom(
        { organizationId: " ", userId: USER_A, agentId: AGENT_A },
        ROOM_A,
        5,
      ),
    ).rejects.toThrow("scope is incomplete");
  });
});

describe("SharedAgentMemoriesReader.searchByEmbedding", () => {
  test("pins the tenant in the bounded inner window and orders by cosine distance", async () => {
    let capturedInnerWhere: SQL | undefined;
    let capturedWindow: number | undefined;
    let capturedOuterLimit: number | undefined;
    let capturedOuterOrder: unknown;
    const hits = [{ id: MEMORY_ID, distance: 0.12 }];

    const subquery = { distance: sql`"recent_shared_agent_memories"."distance"` };
    const asFn = mock(() => subquery);
    const innerLimitFn = mock((window: number) => {
      capturedWindow = window;
      return { as: asFn };
    });
    const innerOrderByFn = mock(() => ({ limit: innerLimitFn }));
    const innerWhereFn = mock((clause: SQL) => {
      capturedInnerWhere = clause;
      return { orderBy: innerOrderByFn };
    });
    const innerFromFn = mock(() => ({ where: innerWhereFn }));

    const outerLimitFn = mock((limit: number) => {
      capturedOuterLimit = limit;
      return Promise.resolve(hits);
    });
    const outerOrderByFn = mock((order: unknown) => {
      capturedOuterOrder = order;
      return { limit: outerLimitFn };
    });
    const outerFromFn = mock((from: unknown) => {
      expect(from).toBe(subquery);
      return { orderBy: outerOrderByFn };
    });

    // The inner select receives the projected column map; the outer select is
    // bare. Route on that difference exactly as the repository issues them.
    const selectFn = mock((...args: unknown[]) =>
      args.length > 0 ? { from: innerFromFn } : { from: outerFromFn },
    );
    const dbReadMock = new Proxy(realClient.dbRead as unknown as Record<PropertyKey, unknown>, {
      get(target, prop, receiver) {
        if (prop === "select") return selectFn;
        return Reflect.get(target, prop, receiver);
      },
    });
    mock.module("../client", () => ({ ...realClient, dbRead: dbReadMock }));
    try {
      const { SHARED_AGENT_MEMORY_SEARCH_WINDOW, SharedAgentMemoriesReader } = await import(
        "./shared-agent-memories"
      );
      const result = await new SharedAgentMemoriesReader().searchByEmbedding(
        scope,
        [0.25, 0.5, 0.25],
        7,
        "BAAI/bge-small-en-v1.5:384:mean:l2:v1",
      );
      expect(result).toEqual(hits as never);
      expect(capturedWindow).toBe(SHARED_AGENT_MEMORY_SEARCH_WINDOW);
      expect(capturedOuterLimit).toBe(7);
      expectTenantPins(capturedInnerWhere);
      const rendered = renderedWhere(capturedInnerWhere);
      expect(rendered.sql).toContain("embedding");
      expect(rendered.sql).toContain("embedding_model");
      expect(rendered.sql).toContain("cardinality");
      expect(rendered.params).toContain(3);
      expect(rendered.params).toContain("BAAI/bge-small-en-v1.5:384:mean:l2:v1");
      const order = new PgDialect().sqlToQuery(capturedOuterOrder as SQL);
      expect(order.sql).toContain("distance");
      expect(order.sql).toContain("asc");
    } finally {
      mock.module("../client", () => realClient);
    }
  });

  test("rejects empty, non-finite, and oversized query vectors", async () => {
    const { SharedAgentMemoriesReader } = await import("./shared-agent-memories");
    const reader = new SharedAgentMemoriesReader();
    await expect(reader.searchByEmbedding(scope, [], 5)).rejects.toThrow("finite vector");
    await expect(reader.searchByEmbedding(scope, [0.5, Number.NaN], 5)).rejects.toThrow(
      "finite vector",
    );
    await expect(reader.searchByEmbedding(scope, new Array(5000).fill(0.1), 5)).rejects.toThrow(
      "finite vector",
    );
    await expect(reader.searchByEmbedding(scope, [0.5], 5, "   ")).rejects.toThrow(
      "embedding model is required",
    );
  });
});

describe("SharedAgentMemoriesWriter.insertMemory", () => {
  function scriptedWrite(returningRows: Array<{ id: string }>) {
    let capturedValues: Record<string, unknown> | undefined;
    const returningFn = mock(() => Promise.resolve(returningRows));
    const onConflictFn = mock(() => ({ returning: returningFn }));
    const valuesFn = mock((values: Record<string, unknown>) => {
      capturedValues = values;
      return { onConflictDoNothing: onConflictFn };
    });
    const insertFn = mock(() => ({ values: valuesFn }));
    const dbWriteMock = new Proxy(realClient.dbWrite as unknown as Record<PropertyKey, unknown>, {
      get(target, prop, receiver) {
        if (prop === "insert") return insertFn;
        return Reflect.get(target, prop, receiver);
      },
    });
    return { dbWriteMock, insertFn, values: () => capturedValues };
  }

  test("stamps the tenant scope onto every inserted row", async () => {
    const script = scriptedWrite([{ id: MEMORY_ID }]);
    mock.module("../client", () => ({ ...realClient, dbWrite: script.dbWriteMock }));
    try {
      const { SharedAgentMemoriesWriter } = await import("./shared-agent-memories");
      const result = await new SharedAgentMemoriesWriter().insertMemory({
        id: MEMORY_ID,
        scope,
        roomId: ROOM_A,
        type: "messages",
        content: { text: "hello" },
      });
      expect(result).toEqual({ id: MEMORY_ID, inserted: true });
      const values = script.values();
      expect(values?.organization_id).toBe(ORG_A);
      expect(values?.user_id).toBe(USER_A);
      expect(values?.agent_id).toBe(AGENT_A);
      expect(values?.type).toBe("messages");
    } finally {
      mock.module("../client", () => realClient);
    }
  });

  test("verifies a conflicting id inside the tenant before reporting a replay", async () => {
    let capturedWhere: SQL | undefined;
    const script = scriptedWrite([]);
    const limitFn = mock(() => Promise.resolve([{ id: MEMORY_ID }]));
    const whereFn = mock((clause: SQL) => {
      capturedWhere = clause;
      return { limit: limitFn };
    });
    const fromFn = mock(() => ({ where: whereFn }));
    const selectFn = mock(() => ({ from: fromFn }));
    const dbReadMock = new Proxy(realClient.dbRead as unknown as Record<PropertyKey, unknown>, {
      get(target, prop, receiver) {
        if (prop === "select") return selectFn;
        return Reflect.get(target, prop, receiver);
      },
    });
    mock.module("../client", () => ({
      ...realClient,
      dbRead: dbReadMock,
      dbWrite: script.dbWriteMock,
    }));
    try {
      const { SharedAgentMemoriesWriter } = await import("./shared-agent-memories");
      const result = await new SharedAgentMemoriesWriter().insertMemory({
        id: MEMORY_ID,
        scope,
        type: "messages",
        content: { text: "replayed" },
      });
      expect(result).toEqual({ id: MEMORY_ID, inserted: false });
      expectTenantPins(capturedWhere);
      const rendered = renderedWhere(capturedWhere);
      expect(rendered.params).toContain(MEMORY_ID);
    } finally {
      mock.module("../client", () => realClient);
    }
  });

  test("throws when a conflicting id is not visible inside the tenant", async () => {
    const script = scriptedWrite([]);
    const limitFn = mock(() => Promise.resolve([]));
    const whereFn = mock(() => ({ limit: limitFn }));
    const fromFn = mock(() => ({ where: whereFn }));
    const selectFn = mock(() => ({ from: fromFn }));
    const dbReadMock = new Proxy(realClient.dbRead as unknown as Record<PropertyKey, unknown>, {
      get(target, prop, receiver) {
        if (prop === "select") return selectFn;
        return Reflect.get(target, prop, receiver);
      },
    });
    mock.module("../client", () => ({
      ...realClient,
      dbRead: dbReadMock,
      dbWrite: script.dbWriteMock,
    }));
    try {
      const { SharedAgentMemoriesWriter } = await import("./shared-agent-memories");
      await expect(
        new SharedAgentMemoriesWriter().insertMemory({
          id: MEMORY_ID,
          scope,
          type: "messages",
          content: { text: "poisoned id" },
        }),
      ).rejects.toThrow("conflicts outside its tenant");
    } finally {
      mock.module("../client", () => realClient);
    }
  });

  test("rejects a row missing its type discriminator", async () => {
    const { SharedAgentMemoriesWriter } = await import("./shared-agent-memories");
    await expect(
      new SharedAgentMemoriesWriter().insertMemory({
        scope,
        type: " ",
        content: { text: "untyped" },
      }),
    ).rejects.toThrow("type is required");
  });
});

describe("SharedAgentMemoriesWriter.mergeMessageMemory", () => {
  test("updates content and its embedding pair in one conflict statement", async () => {
    const capturedSets: Array<Record<string, unknown>> = [];
    const returningFn = mock(() => Promise.resolve([{ id: MEMORY_ID, inserted: false }]));
    const onConflictFn = mock((config: { set: Record<string, unknown> }) => {
      capturedSets.push(config.set);
      return { returning: returningFn };
    });
    const valuesFn = mock(() => ({ onConflictDoUpdate: onConflictFn }));
    const insertFn = mock(() => ({ values: valuesFn }));
    const dbWriteMock = new Proxy(realClient.dbWrite as unknown as Record<PropertyKey, unknown>, {
      get(target, prop, receiver) {
        if (prop === "insert") return insertFn;
        return Reflect.get(target, prop, receiver);
      },
    });
    mock.module("../client", () => ({ ...realClient, dbWrite: dbWriteMock }));
    try {
      const { SharedAgentMemoriesWriter } = await import("./shared-agent-memories");
      const writer = new SharedAgentMemoriesWriter();
      const base = {
        id: MEMORY_ID,
        scope,
        roomId: ROOM_A,
        type: "messages",
        content: { text: "replacement" },
        interrupted: false,
      };

      await writer.mergeMessageMemory(base);
      await writer.mergeMessageMemory({
        ...base,
        embedding: [0.6, 0.8],
        embeddingModel: " canonical-space ",
      });

      const clearSet = capturedSets[0];
      const replaceSet = capturedSets[1];
      expect(clearSet).toBeDefined();
      expect(replaceSet).toBeDefined();
      const renderedEmbedding = new PgDialect().sqlToQuery(clearSet?.embedding as SQL);
      const renderedModel = new PgDialect().sqlToQuery(clearSet?.embedding_model as SQL);
      expect(renderedEmbedding.sql.toLowerCase()).toContain("is distinct from");
      expect(renderedEmbedding.sql).toContain("embedding");
      expect(renderedModel.sql.toLowerCase()).toContain("is distinct from");
      expect(renderedModel.sql).toContain("embedding_model");
      expect(replaceSet?.embedding).toEqual([0.6, 0.8]);
      expect(replaceSet?.embedding_model).toBe("canonical-space");
    } finally {
      mock.module("../client", () => realClient);
    }
  });
});

describe("SharedAgentMemoriesWriter.setMemoryEmbedding", () => {
  test("updates vector and fingerprint atomically under every tenant pin", async () => {
    let capturedSet: Record<string, unknown> | undefined;
    let capturedWhere: SQL | undefined;
    const returningFn = mock(() => Promise.resolve([{ id: MEMORY_ID }]));
    const whereFn = mock((clause: SQL) => {
      capturedWhere = clause;
      return { returning: returningFn };
    });
    const setFn = mock((values: Record<string, unknown>) => {
      capturedSet = values;
      return { where: whereFn };
    });
    const updateFn = mock(() => ({ set: setFn }));
    const dbWriteMock = new Proxy(realClient.dbWrite as unknown as Record<PropertyKey, unknown>, {
      get(target, prop, receiver) {
        if (prop === "update") return updateFn;
        return Reflect.get(target, prop, receiver);
      },
    });
    mock.module("../client", () => ({ ...realClient, dbWrite: dbWriteMock }));
    try {
      const { SharedAgentMemoriesWriter } = await import("./shared-agent-memories");
      await new SharedAgentMemoriesWriter().setMemoryEmbedding({
        id: MEMORY_ID,
        scope,
        contentText: "remember this",
        embedding: [0.6, 0.8],
        embeddingModel: "BAAI/bge-small-en-v1.5:384:mean:l2:v1",
      });

      expect(capturedSet).toEqual({
        embedding: [0.6, 0.8],
        embedding_model: "BAAI/bge-small-en-v1.5:384:mean:l2:v1",
      });
      expectTenantPins(capturedWhere);
      const rendered = renderedWhere(capturedWhere);
      expect(rendered.params).toContain(MEMORY_ID);
      expect(rendered.params).toContain("remember this");
    } finally {
      mock.module("../client", () => realClient);
    }
  });
});

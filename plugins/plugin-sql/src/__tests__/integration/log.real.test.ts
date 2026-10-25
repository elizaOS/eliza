/**
 * Integration tests for log create/get/update/delete against a real isolated
 * PGlite/Postgres adapter, covering the `limit`/legacy-`count` param
 * contract, JSON-body escaping and output bounds, and filtering by type and
 * entity.
 */
import {
  type AgentRuntime,
  ChannelType,
  ElizaError,
  type Entity,
  type Room,
  type UUID,
} from "@elizaos/core";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import {
  MAX_SQL_JSON_SANITIZE_DEPTH,
  MAX_SQL_JSON_SANITIZE_STRING_BYTES,
  SQL_JSON_SANITIZE_UNBOUNDED,
} from "../../sanitize-json";
import { logTable } from "../../schema/log";
import { roomTable } from "../../schema/room";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Log Integration Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let _runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testRoomId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("log-tests");
    adapter = setup.adapter;
    _runtime = setup.runtime;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Generate random UUIDs for test data
    testEntityId = uuidv4() as UUID;
    testRoomId = uuidv4() as UUID;

    // Create necessary entities for foreign key constraints
    await adapter.createEntities([
      {
        id: testEntityId,
        agentId: testAgentId,
        names: ["Test Entity"],
      } as Entity,
    ]);
    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        name: "Test Room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("Log Tests", () => {
    beforeEach(async () => {
      await (adapter.getDatabase() as DrizzleDatabase).delete(logTable);
    });

    it("should create and retrieve a log entry", async () => {
      const logData = {
        body: { message: "hello world" },
        entityId: testEntityId,
        roomId: testRoomId,
        type: "test_log",
      };
      await adapter.log(logData);
      const logs = await adapter.getLogs({
        entityId: testEntityId,
        roomId: testRoomId,
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].body).toEqual({ message: "hello world" });
    });

    it("should not throw when deleting a non-existent log", async () => {
      const nonExistentId = uuidv4() as UUID;
      await expect(adapter.deleteLog(nonExistentId)).resolves.not.toThrow();
    });

    it("honors the `limit` param from the IDatabaseAdapter contract (not just legacy `count`)", async () => {
      for (let i = 0; i < 15; i++) {
        await adapter.log({
          body: { seq: i },
          entityId: testEntityId,
          roomId: testRoomId,
          type: "limit_test",
        });
      }

      const all = await adapter.getLogs({ roomId: testRoomId, limit: 100 });
      expect(all).toHaveLength(15);

      const capped = await adapter.getLogs({ roomId: testRoomId, limit: 5 });
      expect(capped).toHaveLength(5);

      // Legacy `count` alias still works
      const legacy = await adapter.getLogs({ roomId: testRoomId, count: 7 });
      expect(legacy).toHaveLength(7);

      // No limit provided keeps the historical default of 10
      const defaulted = await adapter.getLogs({ roomId: testRoomId });
      expect(defaulted).toHaveLength(10);
    });

    it("round-trips backslashes in log bodies without double-escaping", async () => {
      const body = {
        path: "C:\\Users\\dev\\project",
        regex: "^\\d+\\q$",
        unicodeish: "literal \\u12 sequence",
      };
      await adapter.log({
        body,
        entityId: testEntityId,
        roomId: testRoomId,
        type: "backslash_test",
      });

      const logs = await adapter.getLogs({
        roomId: testRoomId,
        type: "backslash_test",
      });
      expect(logs).toHaveLength(1);
      // sanitizeJsonObject must not double a backslash that isn't followed
      // by a valid JSON escape char (["\/bfnrtu]).
      expect(logs[0].body).toEqual(body);
    });

    it("strips NUL characters so the jsonb insert does not fail", async () => {
      const nul = String.fromCharCode(0);
      await adapter.log({
        body: { text: `a${nul}b` },
        entityId: testEntityId,
        roomId: testRoomId,
        type: "nul_test",
      });

      const logs = await adapter.getLogs({
        roomId: testRoomId,
        type: "nul_test",
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].body).toEqual({ text: "ab" });
    });

    it("rejects an over-depth body before the real adapter inserts a log", async () => {
      let body: Record<string, unknown> = { leaf: true };
      for (let depth = 0; depth <= MAX_SQL_JSON_SANITIZE_DEPTH; depth += 1) {
        body = { child: body };
      }

      try {
        await adapter.log({
          body,
          entityId: testEntityId,
          roomId: testRoomId,
          type: "unbounded_test",
        });
        throw new Error("expected adapter.log to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(ElizaError);
        expect((error as ElizaError).code).toBe("DB_INSERT_FAILED");
        expect((error as Error).cause).toEqual(
          expect.objectContaining({ code: SQL_JSON_SANITIZE_UNBOUNDED })
        );
      }

      const logs = await adapter.getLogs({
        roomId: testRoomId,
        type: "unbounded_test",
      });
      expect(logs).toHaveLength(0);
    });

    it("rejects an oversized scalar before the real adapter inserts a log", async () => {
      await expect(
        adapter.log({
          body: { text: "x".repeat(MAX_SQL_JSON_SANITIZE_STRING_BYTES + 1) },
          entityId: testEntityId,
          roomId: testRoomId,
          type: "oversized_scalar_test",
        })
      ).rejects.toMatchObject({
        code: "DB_INSERT_FAILED",
        cause: expect.objectContaining({ code: SQL_JSON_SANITIZE_UNBOUNDED }),
      });

      const logs = await adapter.getLogs({
        roomId: testRoomId,
        type: "oversized_scalar_test",
      });
      expect(logs).toHaveLength(0);
    });

    it("filters logs by entityId so another entity's rows never leak through", async () => {
      const otherEntityId = uuidv4() as UUID;
      await adapter.createEntities([
        { id: otherEntityId, agentId: testAgentId, names: ["Other Entity"] } as Entity,
      ]);
      await adapter.log({
        body: { message: "mine" },
        entityId: testEntityId,
        roomId: testRoomId,
        type: "shared_type",
      });
      await adapter.log({
        body: { message: "theirs" },
        entityId: otherEntityId,
        roomId: testRoomId,
        type: "shared_type",
      });

      const mine = await adapter.getLogs({ entityId: testEntityId, type: "shared_type" });
      expect(mine).toHaveLength(1);
      expect(mine[0].entityId).toBe(testEntityId);
      expect(mine[0].body).toEqual({ message: "mine" });

      const theirs = await adapter.getLogs({ entityId: otherEntityId, roomId: testRoomId });
      expect(theirs).toHaveLength(1);
      expect(theirs[0].entityId).toBe(otherEntityId);

      const everyone = await adapter.getLogs({ type: "shared_type" });
      expect(everyone.map((log) => log.entityId).sort()).toEqual(
        [testEntityId, otherEntityId].sort()
      );
    });

    it("should filter logs by type", async () => {
      await adapter.log({
        body: { message: "message 1" },
        entityId: testEntityId,
        roomId: testRoomId,
        type: "typeA",
      });
      await adapter.log({
        body: { message: "message 2" },
        entityId: testEntityId,
        roomId: testRoomId,
        type: "typeB",
      });

      const logs = await adapter.getLogs({
        entityId: testEntityId,
        roomId: testRoomId,
        type: "typeA",
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].type).toBe("typeA");
    });
  });

  describe("agent scoping", () => {
    const otherAgentId = uuidv4() as UUID;
    const otherEntityId = uuidv4() as UUID;
    const otherRoomId = uuidv4() as UUID;

    beforeAll(async () => {
      await adapter.createAgent({
        id: otherAgentId,
        name: `log-scope-agent-${otherAgentId.slice(0, 8)}`,
        bio: "second agent sharing the database",
      } as Parameters<typeof adapter.createAgent>[0]);
      await adapter.createEntities([
        { id: otherEntityId, agentId: otherAgentId, names: ["Other Entity"] } as Entity,
      ]);
      // createRooms stamps the calling adapter's agentId, so the other agent's
      // room is written directly, as that agent's own adapter would.
      await (adapter.getDatabase() as DrizzleDatabase).insert(roomTable).values({
        id: otherRoomId,
        agentId: otherAgentId,
        name: "Other Room",
        source: "test",
        type: ChannelType.GROUP,
      });
    });

    beforeEach(async () => {
      await (adapter.getDatabase() as DrizzleDatabase).delete(logTable);
      await adapter.log({
        body: { who: "this agent" },
        entityId: testEntityId,
        roomId: testRoomId,
        type: "inference_timing",
      });
      await adapter.log({
        body: { who: "other agent" },
        entityId: otherEntityId,
        roomId: otherRoomId,
        type: "inference_timing",
      });
    });

    it("returns only this agent's logs when no room filter is given", async () => {
      const byType = await adapter.getLogs({ type: "inference_timing" });
      const all = await adapter.getLogs({ limit: Number.MAX_SAFE_INTEGER });

      expect(byType.map((log) => log.body)).toEqual([{ who: "this agent" }]);
      expect(all.map((log) => log.body)).toEqual([{ who: "this agent" }]);
    });

    it("does not delete or update another agent's log by id", async () => {
      const [foreign] = await (adapter.getDatabase() as DrizzleDatabase)
        .select()
        .from(logTable)
        .where(eq(logTable.roomId, otherRoomId));

      await adapter.updateLogs([{ id: foreign.id as UUID, updates: { type: "rewritten" } }]);
      await adapter.deleteLogs([foreign.id as UUID]);

      const [still] = await (adapter.getDatabase() as DrizzleDatabase)
        .select()
        .from(logTable)
        .where(eq(logTable.id, foreign.id));
      expect(still?.type).toBe("inference_timing");
    });

    it("does not read or single-delete another agent's log by id", async () => {
      const rows = await (adapter.getDatabase() as DrizzleDatabase).select().from(logTable);
      const own = rows.find((row) => row.roomId === testRoomId);
      const foreign = rows.find((row) => row.roomId === otherRoomId);
      if (!own || !foreign) throw new Error("seeded logs missing");

      const read = await adapter.getLogsByIds([own.id as UUID, foreign.id as UUID]);
      await adapter.deleteLog(foreign.id as UUID);

      expect(read.map((log) => log.body)).toEqual([{ who: "this agent" }]);
      const [still] = await (adapter.getDatabase() as DrizzleDatabase)
        .select()
        .from(logTable)
        .where(eq(logTable.id, foreign.id));
      expect(still?.id).toBe(foreign.id);
    });
  });

  it("stores a log body holding a truncated emoji with U+FFFD", async () => {
    await (adapter.getDatabase() as DrizzleDatabase).delete(logTable);
    await adapter.log({
      body: { reply: "done \ud83d" },
      entityId: testEntityId,
      roomId: testRoomId,
      type: "lone-surrogate",
    });

    const [log] = await adapter.getLogs({ roomId: testRoomId, type: "lone-surrogate" });
    expect(log.body).toEqual({ reply: "done \ufffd" });
  });

  it("updates a log body with the same NUL and lone-surrogate handling as log()", async () => {
    await (adapter.getDatabase() as DrizzleDatabase).delete(logTable);
    await adapter.log({
      body: { status: "first" },
      entityId: testEntityId,
      roomId: testRoomId,
      type: "lenient-update",
    });
    const [log] = await adapter.getLogs({ roomId: testRoomId, type: "lenient-update" });
    const nul = String.fromCharCode(0);

    await adapter.updateLogs([
      {
        id: log.id as UUID,
        updates: {
          body: {
            status: `done${nul} \ud83d`,
            source: "kept \ud83d\ude42",
            metadata: { text: `a${nul}b`, reply: "cut \udc00" },
          },
        },
      },
    ]);
    const expected = {
      status: "done \ufffd",
      source: "kept \ud83d\ude42",
      metadata: { text: "ab", reply: "cut \ufffd" },
    };
    const [updated] = await adapter.getLogs({ roomId: testRoomId, type: "lenient-update" });
    expect(updated.body).toEqual(expected);

    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth <= MAX_SQL_JSON_SANITIZE_DEPTH; depth += 1) {
      deep = { child: deep };
    }
    await expect(
      adapter.updateLogs([{ id: log.id as UUID, updates: { body: deep } }])
    ).rejects.toMatchObject({ code: SQL_JSON_SANITIZE_UNBOUNDED });
    const [unchanged] = await adapter.getLogs({ roomId: testRoomId, type: "lenient-update" });
    expect(unchanged.body).toEqual(expected);
  });
});

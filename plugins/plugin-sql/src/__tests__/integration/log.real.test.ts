/**
 * Integration tests for log create/get/delete against a real isolated
 * PGlite/Postgres adapter, covering the `limit`/legacy-`count` param
 * contract, JSON-body escaping (backslashes, NUL stripping), and filtering
 * by type.
 */
import { type AgentRuntime, ChannelType, type Entity, type Room, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { logTable } from "../../schema";
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
});

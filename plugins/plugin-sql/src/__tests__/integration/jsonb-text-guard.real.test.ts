/**
 * Integration proof for the entity-graph jsonb text guard: every write that
 * binds caller objects into a jsonb column through drizzle's default
 * serialization (agent settings, entity/room/world/task/relationship
 * metadata, component data, cache values) rejects NUL and lone UTF-16
 * surrogates with the typed SQL_JSON_UNSUPPORTED_* errors before the driver
 * bind, keeps the caller's content out of the failure diagnostic, and leaves
 * admissible payloads — including ones past the strict memory sanitizer's
 * structural budgets — writable. Real isolated PGlite via the shared
 * migration harness; no mocked adapters.
 */
import {
  ChannelType,
  type Component,
  type Entity,
  type Relationship,
  type Room,
  type Task,
  type UUID,
  type World,
} from "@elizaos/core";
import { v4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { createIsolatedTestDatabase } from "../test-helpers";

const NUL_METADATA = { note: "bad\0note" };
const LONE_SURROGATE_METADATA = { note: "x \ud83d" };

/** One NUL and one lone-surrogate row per write, with the typed code each must produce. */
const UNSUPPORTED_PAYLOADS = [
  ["NUL", NUL_METADATA, "SQL_JSON_UNSUPPORTED_NUL"],
  ["lone surrogate", LONE_SURROGATE_METADATA, "SQL_JSON_UNSUPPORTED_SURROGATE"],
] as const;

describe("entity-graph jsonb text guard", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let roomId: UUID;
  let entityId: UUID;
  let otherEntityId: UUID;
  let worldId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("jsonb_text_guard_tests");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    worldId = v4() as UUID;
    roomId = v4() as UUID;
    entityId = v4() as UUID;
    otherEntityId = v4() as UUID;

    await adapter.createWorld({
      id: worldId,
      agentId: testAgentId,
      name: "Guard World",
      serverId: "guard-server",
    } as World);
    await adapter.createRooms([
      {
        id: roomId,
        agentId: testAgentId,
        worldId,
        name: "Guard Room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.createEntities([
      { id: entityId, agentId: testAgentId, names: ["Guard Entity"] } as Entity,
      { id: otherEntityId, agentId: testAgentId, names: ["Other Entity"] } as Entity,
    ]);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  /**
   * Runs the write once and requires the typed jsonb rejection: no drizzle
   * "Failed query" wrapper (the guard must fire before the bind), and none of
   * the rejected content in the diagnostic.
   */
  async function expectTypedJsonbRejection(
    write: () => Promise<unknown>,
    code: "SQL_JSON_UNSUPPORTED_NUL" | "SQL_JSON_UNSUPPORTED_SURROGATE"
  ): Promise<void> {
    let thrown: unknown;
    try {
      await write();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code });
    const diagnostic = thrown instanceof Error ? thrown.message : String(thrown);
    expect(diagnostic).not.toContain("Failed query");
    expect(diagnostic).not.toContain("bad\0note");
    expect(diagnostic).not.toContain("x \ud83d");
  }

  it.each(UNSUPPORTED_PAYLOADS)(
    "updateEntity rejects %s metadata (%s)",
    async (_label, metadata, code) => {
      const id = v4() as UUID;
      await adapter.createEntities([{ id, agentId: testAgentId, names: ["Guard"] } as Entity]);
      await expectTypedJsonbRejection(
        () =>
          adapter.updateEntity({
            id,
            agentId: testAgentId,
            names: ["Guard"],
            metadata,
          } as Entity),
        code
      );
    }
  );

  it.each(UNSUPPORTED_PAYLOADS)(
    "createComponent rejects %s data (%s)",
    async (_label, data, code) => {
      await expectTypedJsonbRejection(
        () =>
          adapter.createComponent({
            id: v4() as UUID,
            type: "guard",
            agentId: testAgentId,
            entityId,
            roomId,
            data,
          } as Component),
        code
      );
    }
  );

  it.each(UNSUPPORTED_PAYLOADS)(
    "updateRoom rejects %s metadata (%s)",
    async (_label, metadata, code) => {
      await expectTypedJsonbRejection(
        () =>
          adapter.updateRoom({
            id: roomId,
            agentId: testAgentId,
            worldId,
            name: "Guard Room",
            source: "test",
            type: ChannelType.GROUP,
            metadata,
          } as Room),
        code
      );
    }
  );

  it.each(UNSUPPORTED_PAYLOADS)(
    "updateWorld rejects %s metadata (%s)",
    async (_label, metadata, code) => {
      const stored = await adapter.getWorld(worldId);
      expect(stored).not.toBeNull();
      await expectTypedJsonbRejection(
        () =>
          adapter.updateWorld({
            ...stored,
            metadata: { ...(stored?.metadata ?? {}), ...metadata },
          } as World),
        code
      );
    }
  );

  it.each(UNSUPPORTED_PAYLOADS)(
    "createTask rejects %s metadata (%s)",
    async (_label, metadata, code) => {
      await expectTypedJsonbRejection(
        () =>
          adapter.createTask({
            name: "guard-task",
            description: "guard task",
            roomId,
            tags: ["guard"],
            metadata,
          } as Task),
        code
      );
    }
  );

  it.each(UNSUPPORTED_PAYLOADS)(
    "createEntities rejects %s metadata (%s)",
    async (_label, metadata, code) => {
      await expectTypedJsonbRejection(
        () =>
          adapter.createEntities([
            { id: v4() as UUID, agentId: testAgentId, names: ["Guard"], metadata } as Entity,
          ]),
        code
      );
    }
  );

  it.each(UNSUPPORTED_PAYLOADS)(
    "createRelationship rejects %s metadata (%s)",
    async (_label, metadata, code) => {
      await expectTypedJsonbRejection(
        () =>
          adapter.createRelationship({
            sourceEntityId: entityId,
            targetEntityId: otherEntityId,
            tags: ["guard"],
            metadata,
          }),
        code
      );
    }
  );

  it.each(UNSUPPORTED_PAYLOADS)("setCache rejects %s value (%s)", async (_label, value, code) => {
    await expectTypedJsonbRejection(() => adapter.setCache(`guard:${v4()}`, value), code);
  });

  it.each(UNSUPPORTED_PAYLOADS)(
    "updateAgent rejects %s settings (%s)",
    async (_label, badValues, code) => {
      await expectTypedJsonbRejection(
        () =>
          adapter.updateAgent(testAgentId, {
            settings: { values: { ...badValues } },
          }),
        code
      );
    }
  );

  describe("remaining entity-graph write paths", () => {
    it.each(UNSUPPORTED_PAYLOADS)(
      "createAgent rejects %s settings (%s)",
      async (_label, badValues, code) => {
        await expectTypedJsonbRejection(
          () =>
            adapter.createAgent({
              id: v4() as UUID,
              name: "guard-agent",
              settings: { values: { ...badValues } },
            }),
          code
        );
      }
    );

    it("updateComponent rejects a lone surrogate in data", async () => {
      const componentId = v4() as UUID;
      await adapter.createComponent({
        id: componentId,
        type: "guard",
        agentId: testAgentId,
        entityId,
        roomId,
        data: { note: "ok" },
      } as Component);
      await expectTypedJsonbRejection(
        () =>
          adapter.updateComponent({
            id: componentId,
            type: "guard",
            agentId: testAgentId,
            entityId,
            roomId,
            data: LONE_SURROGATE_METADATA,
            createdAt: Date.now(),
          } as Component),
        "SQL_JSON_UNSUPPORTED_SURROGATE"
      );
    });

    it("createRooms rejects a lone surrogate in metadata", async () => {
      await expectTypedJsonbRejection(
        () =>
          adapter.createRooms([
            {
              id: v4() as UUID,
              agentId: testAgentId,
              worldId,
              name: "Guard Room 2",
              source: "test",
              type: ChannelType.GROUP,
              metadata: LONE_SURROGATE_METADATA,
            } as Room,
          ]),
        "SQL_JSON_UNSUPPORTED_SURROGATE"
      );
    });

    it("updateRelationship rejects a lone surrogate in metadata", async () => {
      const sourceId = v4() as UUID;
      const targetId = v4() as UUID;
      await adapter.createEntities([
        { id: sourceId, agentId: testAgentId, names: ["Rel Source"] } as Entity,
        { id: targetId, agentId: testAgentId, names: ["Rel Target"] } as Entity,
      ]);
      const created = await adapter.createRelationship({
        sourceEntityId: sourceId,
        targetEntityId: targetId,
        tags: ["guard"],
        metadata: { note: "ok" },
      });
      expect(created).toBe(true);
      const stored = await adapter.getRelationship({
        sourceEntityId: sourceId,
        targetEntityId: targetId,
      });
      expect(stored).not.toBeNull();
      await expectTypedJsonbRejection(
        () =>
          adapter.updateRelationship({
            ...stored,
            metadata: LONE_SURROGATE_METADATA,
          } as Relationship),
        "SQL_JSON_UNSUPPORTED_SURROGATE"
      );
    });

    it("createWorld rejects a lone surrogate in metadata", async () => {
      await expectTypedJsonbRejection(
        () =>
          adapter.createWorld({
            id: v4() as UUID,
            agentId: testAgentId,
            name: "Guard World 2",
            serverId: "guard-server",
            metadata: LONE_SURROGATE_METADATA,
          } as World),
        "SQL_JSON_UNSUPPORTED_SURROGATE"
      );
    });

    it("compareAndSwapWorldMetadata rejects a lone surrogate in the replacement", async () => {
      const stored = await adapter.getWorld(worldId);
      expect(stored).not.toBeNull();
      await expectTypedJsonbRejection(
        () =>
          adapter.compareAndSwapWorldMetadata({
            worldId,
            expectedMetadata: stored?.metadata ?? {},
            replacementMetadata: {
              ...(stored?.metadata ?? {}),
              ...LONE_SURROGATE_METADATA,
            },
          }),
        "SQL_JSON_UNSUPPORTED_SURROGATE"
      );
    });

    it("patchComponents rejects a lone surrogate in a patched value", async () => {
      const componentId = v4() as UUID;
      await adapter.createComponent({
        id: componentId,
        type: "guard",
        agentId: testAgentId,
        entityId,
        roomId,
        data: { note: "ok" },
      } as Component);
      await expectTypedJsonbRejection(
        () =>
          adapter.patchComponents([
            {
              componentId,
              ops: [{ op: "set", path: "note", value: "x \ud83d" }],
            },
          ]),
        "SQL_JSON_UNSUPPORTED_SURROGATE"
      );
    });

    it("updatePendingTask rejects a lone surrogate in metadata", async () => {
      const taskId = await adapter.createTask({
        name: "guard-pending",
        description: "guard pending task",
        roomId,
        tags: ["queue"],
        metadata: { status: "pending" },
      } as Task);
      await expectTypedJsonbRejection(
        () =>
          adapter.updatePendingTask(taskId, {
            metadata: { status: "pending", ...LONE_SURROGATE_METADATA },
          }),
        "SQL_JSON_UNSUPPORTED_SURROGATE"
      );
    });

    it("patchTaskMetadata rejects a lone surrogate in the patch set", async () => {
      const taskId = await adapter.createTask({
        name: "guard-patch",
        description: "guard patch task",
        roomId,
        tags: ["guard"],
        metadata: { status: "pending" },
      } as Task);
      await expectTypedJsonbRejection(
        () => adapter.patchTaskMetadata(taskId, { set: { ...LONE_SURROGATE_METADATA } }),
        "SQL_JSON_UNSUPPORTED_SURROGATE"
      );
    });

    // compareAndSetCache is intentionally absent here: its snapshot encoder in
    // @elizaos/core already rejects unsupported text before the bind with the
    // CAS-specific typed CACHE_CAS_INVALID_VALUE contract pinned by
    // cache-cas.real.test.ts, so it never produced the raw driver errors this
    // suite repairs.
  });

  describe("admissible writes keep working", () => {
    it("benign metadata still writes", async () => {
      const id = v4() as UUID;
      await adapter.createEntities([
        {
          id,
          agentId: testAgentId,
          names: ["Benign"],
          metadata: { note: "ok", emoji: "🙂" },
        } as Entity,
      ]);
      const stored = await adapter.getEntitiesByIds([id]);
      expect(stored[0]?.metadata).toEqual({ note: "ok", emoji: "🙂" });
    });

    it("a paired surrogate still writes", async () => {
      const key = `guard-paired:${v4()}`;
      await adapter.setCache(key, { note: "truncated not: 🙂" });
      expect(await adapter.getCache(key)).toEqual({ note: "truncated not: 🙂" });
    });

    it("component data past the memory sanitizer's byte budget still writes (text-only guard)", async () => {
      const id = v4() as UUID;
      await expect(
        adapter.createComponent({
          id,
          type: "guard",
          agentId: testAgentId,
          entityId,
          roomId,
          data: { note: "m".repeat(1_200_000) },
        } as Component)
      ).resolves.toBe(true);
    });
  });
});

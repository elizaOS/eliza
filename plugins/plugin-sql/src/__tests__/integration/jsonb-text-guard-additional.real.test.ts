/**
 * Entity-graph jsonb writes reject NUL and lone surrogates with the typed
 * SQL_JSON errors before the bind, and leave the stored row unchanged.
 * Nesting past the memory serializer's depth cap still stores: this guard is
 * text-only.
 */
import {
  type AgentRuntime,
  ChannelType,
  type Component,
  type Entity,
  type Metadata,
  type Room,
  type UUID,
  type World,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { MAX_SQL_JSON_SANITIZE_DEPTH } from "../../sanitize-json";
import { createIsolatedTestDatabase } from "../test-helpers";

const LONE_SURROGATE = "\ud83d";
const NUL = "\u0000";

describe("jsonb text guard", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let _runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let agentId: UUID;
  let worldId: UUID;
  let roomId: UUID;
  let entityId: UUID;
  let sourceEntityId: UUID;
  let componentId: UUID;
  let taskId: UUID;
  let relationshipId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("jsonb-text-guard");
    adapter = setup.adapter;
    _runtime = setup.runtime;
    cleanup = setup.cleanup;
    agentId = setup.testAgentId;
    worldId = uuidv4() as UUID;
    roomId = uuidv4() as UUID;
    entityId = uuidv4() as UUID;
    sourceEntityId = uuidv4() as UUID;
    componentId = uuidv4() as UUID;
    await adapter.createWorld({
      id: worldId,
      agentId,
      name: "guard world",
      serverId: "test-server",
      metadata: { note: "kept" },
    } as World);
    await adapter.createRooms([
      {
        id: roomId,
        agentId,
        worldId,
        name: "guard room",
        source: "test",
        type: ChannelType.GROUP,
        metadata: { note: "kept" },
      } as Room,
    ]);
    await adapter.createEntities([
      { id: entityId, agentId, names: ["Guard Entity"], metadata: { note: "kept" } } as Entity,
      { id: sourceEntityId, agentId, names: ["Source"] } as Entity,
    ]);
    await adapter.createComponent({
      id: componentId,
      entityId,
      agentId,
      roomId,
      worldId,
      sourceEntityId,
      type: "guard",
      data: { note: "kept" },
    } as Component);
    taskId = await adapter.createTask({
      name: "guard task",
      roomId,
      worldId,
      tags: ["queue"],
      metadata: { note: "kept" },
    });
    await adapter.createRelationship({
      sourceEntityId: entityId,
      targetEntityId: sourceEntityId,
      tags: ["knows"],
      metadata: { note: "kept" },
    });
    const relationship = await adapter.getRelationship({
      sourceEntityId: entityId,
      targetEntityId: sourceEntityId,
    });
    if (!relationship) throw new Error("seed relationship missing");
    relationshipId = relationship.id;
    await adapter.setCache("guard-key", { note: "kept" });
  });

  afterAll(async () => {
    await cleanup?.();
  });

  const badValues = [
    {
      label: "a lone surrogate",
      text: `x ${LONE_SURROGATE}`,
      code: "SQL_JSON_UNSUPPORTED_SURROGATE",
    },
    { label: "NUL", text: `a${NUL}b`, code: "SQL_JSON_UNSUPPORTED_NUL" },
  ] as const;

  async function rejects(code: string, write: () => Promise<unknown>): Promise<void> {
    await expect(write()).rejects.toMatchObject({ code });
  }

  it.each(badValues)(
    "updateEntity rejects $label and keeps the stored metadata",
    async ({ text, code }) => {
      const before = (await adapter.getEntitiesByIds([entityId]))[0]?.metadata;
      await rejects(code, () =>
        adapter.updateEntity({
          id: entityId,
          agentId,
          names: ["Guard Entity"],
          metadata: { note: text },
        } as Entity)
      );
      expect((await adapter.getEntitiesByIds([entityId]))[0]?.metadata).toEqual(before);
    }
  );

  it.each(badValues)("createEntities rejects $label before inserting", async ({ text, code }) => {
    const id = uuidv4() as UUID;
    await rejects(code, () =>
      adapter.createEntities([{ id, agentId, names: ["new"], metadata: { note: text } } as Entity])
    );
    expect(await adapter.getEntitiesByIds([id])).toEqual([]);
  });

  it.each(badValues)(
    "createComponent and updateComponent reject $label",
    async ({ text, code }) => {
      const id = uuidv4() as UUID;
      await rejects(code, () =>
        adapter.createComponent({
          id,
          entityId,
          agentId,
          roomId,
          worldId,
          sourceEntityId,
          type: `bad-${code}`,
          data: { note: text },
        } as Component)
      );
      expect(
        await adapter.getComponent(entityId, `bad-${code}`, worldId, sourceEntityId)
      ).toBeNull();

      const before = await adapter.getComponent(entityId, "guard", worldId, sourceEntityId);
      await rejects(code, () =>
        adapter.updateComponent({ ...(before as Component), data: { note: text } })
      );
      expect(
        (await adapter.getComponent(entityId, "guard", worldId, sourceEntityId))?.data
      ).toEqual({
        note: "kept",
      });
      await rejects(code, () =>
        adapter.patchComponents([{ componentId, ops: [{ op: "set", path: "note", value: text }] }])
      );
      expect(
        (await adapter.getComponent(entityId, "guard", worldId, sourceEntityId))?.data
      ).toEqual({
        note: "kept",
      });
    }
  );

  it.each(badValues)("room writes reject $label", async ({ text, code }) => {
    const before = (await adapter.getRoomsByIds([roomId]))?.[0]?.metadata;
    await rejects(code, () =>
      adapter.updateRoom({
        id: roomId,
        agentId,
        worldId,
        name: "guard room",
        source: "test",
        type: ChannelType.GROUP,
        metadata: { note: text },
      } as Room)
    );
    expect((await adapter.getRoomsByIds([roomId]))?.[0]?.metadata).toEqual(before);

    const id = uuidv4() as UUID;
    await rejects(code, () =>
      adapter.createRooms([
        {
          id,
          agentId,
          worldId,
          name: "bad room",
          source: "test",
          type: ChannelType.GROUP,
          metadata: { note: text },
        } as Room,
      ])
    );
    expect(await adapter.getRoomsByIds([id])).toEqual([]);
  });

  it.each(badValues)("world writes reject $label", async ({ text, code }) => {
    const before = await adapter.getWorld(worldId);
    await rejects(code, () =>
      adapter.updateWorld({ ...(before as World), metadata: { note: text } })
    );
    expect((await adapter.getWorld(worldId))?.metadata).toEqual(before?.metadata);
    await rejects(code, () =>
      adapter.compareAndSwapWorldMetadata({
        worldId,
        expectedMetadata: (before?.metadata ?? {}) as Metadata,
        replacementMetadata: { ...(before?.metadata ?? {}), note: text },
      })
    );
    expect((await adapter.getWorld(worldId))?.metadata).toEqual(before?.metadata);

    const id = uuidv4() as UUID;
    await rejects(code, () =>
      adapter.createWorld({
        id,
        agentId,
        name: "bad world",
        serverId: "test-server",
        metadata: { note: text },
      } as World)
    );
    expect(await adapter.getWorld(id)).toBeNull();
  });

  it.each(badValues)("task writes reject $label", async ({ text, code }) => {
    const [before] = await adapter.getTasks({ agentIds: [agentId], roomId });
    await rejects(code, () => adapter.updateTask(taskId, { metadata: { note: text } }));
    await rejects(code, () => adapter.updatePendingTask(taskId, { metadata: { note: text } }));
    await rejects(code, () => adapter.patchTaskMetadata(taskId, { set: { note: text } }));
    const [after] = await adapter.getTasks({ agentIds: [agentId], roomId });
    expect(after?.metadata).toEqual(before?.metadata);

    const id = uuidv4() as UUID;
    await rejects(code, () =>
      adapter.createTask({ id, name: "bad", roomId, tags: ["queue"], metadata: { note: text } })
    );
    expect(
      (await adapter.getTasks({ agentIds: [agentId], roomId })).map((task) => task.id)
    ).toEqual([taskId]);
  });

  it.each(badValues)(
    "relationship, cache, and agent writes reject $label",
    async ({ text, code }) => {
      const beforeRelationship = await adapter.getRelationship({
        sourceEntityId: entityId,
        targetEntityId: sourceEntityId,
      });
      await rejects(code, () =>
        adapter.updateRelationship({
          ...(beforeRelationship as NonNullable<typeof beforeRelationship>),
          metadata: { note: text },
        })
      );
      await rejects(code, () =>
        adapter.createRelationship({
          sourceEntityId: sourceEntityId,
          targetEntityId: entityId,
          tags: [text],
          metadata: { note: "kept" },
        })
      );
      expect(
        await adapter.getRelationship({
          sourceEntityId: entityId,
          targetEntityId: sourceEntityId,
        })
      ).toMatchObject({ id: relationshipId, metadata: { note: "kept" } });
      expect(
        await adapter.getRelationship({
          sourceEntityId: sourceEntityId,
          targetEntityId: entityId,
        })
      ).toBeNull();

      await rejects(code, () => adapter.setCache("guard-key", { note: text }));
      expect(await adapter.getCache("guard-key")).toEqual({ note: "kept" });

      const beforeAgent = await adapter.getAgent(agentId);
      await rejects(code, () => adapter.updateAgent(agentId, { settings: { note: text } }));
      expect((await adapter.getAgent(agentId))?.settings).toEqual(beforeAgent?.settings);

      const id = uuidv4() as UUID;
      await rejects(code, () =>
        adapter.createAgent({
          ...(beforeAgent as NonNullable<typeof beforeAgent>),
          id,
          name: "bad agent",
          bio: [text],
        })
      );
      expect(await adapter.getAgent(id)).toBeNull();
    }
  );

  it("stores a valid emoji and nesting past the serializer depth cap", async () => {
    await adapter.updateEntity({
      id: entityId,
      agentId,
      names: ["Guard Entity"],
      metadata: { note: "🙂" },
    } as Entity);
    expect((await adapter.getEntitiesByIds([entityId]))[0]?.metadata).toEqual({ note: "🙂" });

    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let depth = 0; depth <= MAX_SQL_JSON_SANITIZE_DEPTH + 8; depth += 1) {
      deep = { child: deep };
    }
    await adapter.updateRoom({
      id: roomId,
      agentId,
      worldId,
      name: "guard room",
      source: "test",
      type: ChannelType.GROUP,
      metadata: deep,
    } as Room);
    expect((await adapter.getRoomsByIds([roomId]))?.[0]?.metadata).toEqual(deep);
  });
});

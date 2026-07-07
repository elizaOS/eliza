/**
 * Pins the adapter semantics the sub-agent entity lifecycle fix (#15102,
 * plugin-agent-orchestrator SubAgentRouter) depends on, against a real
 * isolated PGlite/Postgres adapter:
 *
 * 1. `deleteParticipants` removes ONLY participant rows — unlinked entities
 *    vanish from `getEntitiesForRooms` (a participants→entities join) while
 *    their rows and the transcript memories that FK them survive, and
 *    `getEntitiesByIds` still resolves their original display names (what
 *    recentMessages' author backfill reads).
 * 2. `createEntities` is idempotent by id (ON CONFLICT DO NOTHING), so the
 *    router's per-event shared-entity create never grows the table: N
 *    completion cycles add exactly one entity row and one participant row.
 * 3. The reason the sweep must NOT delete entity rows: `deleteEntity`
 *    cascades to the memories that FK it (schema/memory.ts onDelete cascade),
 *    destroying historical transcripts.
 */
import { ChannelType, type Entity, type Memory, type Room, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { createIsolatedTestDatabase } from "../test-helpers";

// Mirrors the structural creation-time marker the router stamps on entities
// (metadata[MESSAGE_SOURCE_SUB_AGENT]); the sweep classifies on it.
const SUB_AGENT_KEY = "sub_agent";

describe("sub-agent entity unlink semantics (#15102)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("sub-agent-entity-unlink");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  async function createRoom(): Promise<UUID> {
    const roomId = uuidv4() as UUID;
    await adapter.createRooms([
      {
        id: roomId,
        agentId: testAgentId,
        name: "sub-agent room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    return roomId;
  }

  function legacyEntity(label: string): Entity {
    return {
      id: uuidv4() as UUID,
      agentId: testAgentId,
      names: [`sub-agent: ${label}`],
      metadata: {
        [SUB_AGENT_KEY]: {
          subAgentSessionId: uuidv4(),
          subAgentAgentType: "codex",
        },
      },
    };
  }

  function transcriptMemory(entityId: UUID, roomId: UUID, text: string): Memory {
    return {
      id: uuidv4() as UUID,
      entityId,
      agentId: testAgentId,
      roomId,
      content: { text, source: SUB_AGENT_KEY },
    };
  }

  it("deleteParticipants hides legacy entities from the room read while transcripts and entity rows survive with their names", async () => {
    const roomId = await createRoom();
    const legacy = [
      legacyEntity("old task a"),
      legacyEntity("old task b"),
      legacyEntity("old task c"),
    ];
    const humans: Entity[] = [
      { id: uuidv4() as UUID, agentId: testAgentId, names: ["nubs"] },
      { id: uuidv4() as UUID, agentId: testAgentId, names: ["shaw"] },
    ];
    const shared: Entity = {
      id: uuidv4() as UUID,
      agentId: testAgentId,
      names: ["sub-agents"],
      metadata: { [SUB_AGENT_KEY]: { shared: true } },
    };
    await adapter.createEntities([...legacy, ...humans, shared]);
    await adapter.addParticipantsRoom(
      [...legacy, ...humans, shared].map((e) => e.id as UUID),
      roomId
    );
    for (const entity of legacy) {
      await adapter.createMemory(
        transcriptMemory(entity.id as UUID, roomId, `transcript of ${entity.names[0]}`),
        "memories"
      );
    }

    const before = (await adapter.getEntitiesForRooms([roomId]))[0]?.entities ?? [];
    expect(before).toHaveLength(6);

    // The router's sweep: classify on the structural marker, unlink in one batch.
    const stale = before.filter((entity) => {
      const marker = entity.metadata?.[SUB_AGENT_KEY];
      return (
        typeof marker === "object" &&
        marker !== null &&
        !Array.isArray(marker) &&
        typeof (marker as Record<string, unknown>).subAgentSessionId === "string"
      );
    });
    expect(stale.map((e) => e.id).sort()).toEqual(legacy.map((e) => e.id).sort());
    await adapter.deleteParticipants(stale.map((e) => ({ entityId: e.id as UUID, roomId })));

    // Room read (participants join) now shows humans + shared only.
    const after = (await adapter.getEntitiesForRooms([roomId]))[0]?.entities ?? [];
    expect(after.map((e) => e.names[0]).sort()).toEqual(["nubs", "shaw", "sub-agents"]);

    // Transcript memories are untouched and their entityId FKs still resolve
    // to the original per-task display names (rendering-attribution pin).
    const memories = await adapter.getMemories({ tableName: "memories", roomId });
    expect(memories).toHaveLength(3);
    const authors = await adapter.getEntitiesByIds(memories.map((m) => m.entityId));
    expect(authors.map((a) => a.names[0]).sort()).toEqual([
      "sub-agent: old task a",
      "sub-agent: old task b",
      "sub-agent: old task c",
    ]);
  });

  it("N completion cycles of the shared-entity create grow the table by exactly one entity and one participant", async () => {
    const roomId = await createRoom();
    const human: Entity = { id: uuidv4() as UUID, agentId: testAgentId, names: ["nubs"] };
    await adapter.createEntities([human]);
    await adapter.addParticipantsRoom([human.id as UUID], roomId);

    const sharedId = uuidv4() as UUID;
    for (let cycle = 0; cycle < 10; cycle++) {
      // The router's per-event sequence: idempotent create, participation,
      // then the routed memory carrying the per-session identity.
      await adapter.createEntities([
        {
          id: sharedId,
          agentId: testAgentId,
          names: ["sub-agents"],
          metadata: { [SUB_AGENT_KEY]: { shared: true } },
        },
      ]);
      await adapter.addParticipant(sharedId, roomId);
      await adapter.createMemory(
        {
          id: uuidv4() as UUID,
          entityId: sharedId,
          agentId: testAgentId,
          roomId,
          content: {
            text: `[sub-agent: task ${cycle} (codex) — task_complete]\ndone`,
            source: SUB_AGENT_KEY,
            metadata: { subAgentSessionId: uuidv4() },
          },
        },
        "memories"
      );
    }

    const entities = (await adapter.getEntitiesForRooms([roomId]))[0]?.entities ?? [];
    expect(entities).toHaveLength(2);
    expect(entities.map((e) => e.names[0]).sort()).toEqual(["nubs", "sub-agents"]);
    const participants = await adapter.getParticipantsForRoom(roomId);
    expect(participants.sort()).toEqual([human.id, sharedId].sort());
    // Every cycle's memory landed under the one shared entity.
    const memories = await adapter.getMemories({ tableName: "memories", roomId });
    expect(memories).toHaveLength(10);
    expect(new Set(memories.map((m) => m.entityId))).toEqual(new Set([sharedId]));
  });

  it("deleting a legacy entity row cascades its transcripts — the hazard the unlink avoids", async () => {
    const roomId = await createRoom();
    const doomed = legacyEntity("doomed task");
    await adapter.createEntities([doomed]);
    await adapter.addParticipantsRoom([doomed.id as UUID], roomId);
    await adapter.createMemory(
      transcriptMemory(doomed.id as UUID, roomId, "transcript that must not be GC'd"),
      "memories"
    );

    await adapter.deleteEntity(doomed.id as UUID);

    const memories = await adapter.getMemories({ tableName: "memories", roomId });
    expect(memories).toHaveLength(0);
  });
});

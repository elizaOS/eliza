/** Exercises actual SQLite files, adapter rollback, restart search and backup restore. */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelType,
  compareMemoryIds,
  type Memory,
  MemoryType,
  ROLE_WRITE_AUDIT_LOG_TYPE,
  Role,
  readDocumentMutationSnapshot,
  type UUID,
  WORLD_METADATA_REVISION_KEY,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SQLiteDatabaseAdapter } from "./adapter";
import { SQLiteStorage } from "./storage";

const id = () => randomUUID() as UUID;
const agentId = id();
const roomId = id();
const entityId = id();
let directory: string;
const opened: SQLiteDatabaseAdapter[] = [];
async function open(file = "agent.sqlite", owner = agentId) {
  const adapter = SQLiteDatabaseAdapter.create(join(directory, file), owner);
  opened.push(adapter);
  await adapter.initialize();
  return adapter;
}
function memory(text: string): Memory & { id: UUID } {
  return {
    id: id(),
    agentId,
    entityId,
    roomId,
    content: { text },
    createdAt: Date.now(),
    embedding: [1, 0, 0],
  };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "eliza-sqlite-"));
});
afterEach(async () => {
  for (const adapter of opened.splice(0)) await adapter.close();
  await rm(directory, { recursive: true, force: true });
});

describe("durable SQLite agent adapter", () => {
  it("keeps the newer memory when two vectors are equally close", async () => {
    const adapter = await open();
    await adapter.ensureEmbeddingDimension(3);
    const olderId = "00000000-0000-4000-8000-000000000001" as UUID;
    const newerId = "ffffffff-ffff-4fff-8fff-ffffffffffff" as UUID;
    const older = {
      ...memory("older"),
      id: olderId,
      createdAt: 1_700_000_000_000,
      embedding: [1, 0, 0],
    };
    const newer = {
      ...memory("newer"),
      id: newerId,
      createdAt: 1_700_000_000_005,
      embedding: [1, 0, 0],
    };
    await adapter.createMemories([
      { memory: older, tableName: "messages" },
      { memory: newer, tableName: "messages" },
    ]);
    const hits = await adapter.searchMemories({
      tableName: "messages",
      embedding: [1, 0, 0],
      roomId,
      count: 1,
      match_threshold: 0.5,
    });
    expect(hits.map((row) => row.id)).toEqual([newerId]);
  });

  it("keeps a createdAt of 0 inside an inclusive start/end window", async () => {
    const adapter = await open();
    const epoch = {
      ...memory("epoch-message"),
      createdAt: 0,
      embedding: undefined,
    };
    const later = {
      ...memory("later-message"),
      createdAt: 10,
      embedding: undefined,
    };
    await adapter.createMemories([
      { memory: epoch, tableName: "messages" },
      { memory: later, tableName: "messages" },
    ]);

    const epochOnly = await adapter.getMemories({
      roomId,
      tableName: "messages",
      start: 0,
      end: 0,
    });
    expect(epochOnly.map((row) => row.content.text)).toEqual(["epoch-message"]);

    const throughLater = await adapter.getMemories({
      roomId,
      tableName: "messages",
      start: 1,
      end: 10,
    });
    expect(throughLater.map((row) => row.content.text)).toEqual([
      "later-message",
    ]);
  });

  it("keeps quoted phrases, negation and OR in message search, like plugin-sql", async () => {
    const adapter = await open();
    const adjacent = "the exact phrase alpha beta lives here";
    const apart = "alpha appears alone and beta appears far away later";
    const misspelled = "alpah or zephry are deliberately misspelled";
    const zephyr = "duplicate marker zephyr";
    const ticket = "ticket abc-123 is closed";
    await adapter.createMemories(
      [adjacent, apart, misspelled, zephyr, ticket].map((text, index) => ({
        memory: {
          ...memory(text),
          createdAt: 1_700_000_000_000 + index,
          embedding: undefined,
        },
        tableName: "messages",
      })),
    );
    const search = async (query: string) =>
      (
        await adapter.searchMessages({
          roomIds: [roomId],
          query,
          tableName: "messages",
          limit: 50,
        })
      )
        .map((hit) => hit.memory.content.text)
        .sort();

    expect(await search('"alpha beta"')).toEqual([adjacent]);
    expect(await search("alpha beta")).toEqual([apart, adjacent].sort());
    expect(await search("alpha -far")).toEqual([adjacent]);
    expect(await search("alpha OR zephyr")).toEqual(
      [adjacent, apart, zephyr].sort(),
    );
    // An interior hyphen is ordinary text, not negation.
    expect(await search("abc-123")).toEqual([ticket]);
  });

  it("deletes document fragments when the document is deleted", async () => {
    const adapter = await open();
    const documentId = id();
    const fragmentId = id();
    const unrelatedId = id();
    const base = {
      agentId,
      entityId,
      roomId,
      embedding: undefined,
      createdAt: 1_700_000_000_000,
    };
    await adapter.createMemories([
      {
        memory: {
          ...base,
          id: documentId,
          content: { text: "source document" },
        },
        tableName: "documents",
      },
      {
        memory: {
          ...base,
          id: fragmentId,
          content: { text: "chunk that should disappear" },
          metadata: { type: MemoryType.FRAGMENT, documentId, position: 0 },
        },
        tableName: "document_fragments",
      },
      {
        memory: {
          ...base,
          id: unrelatedId,
          content: { text: "keep this chunk" },
          metadata: {
            type: MemoryType.FRAGMENT,
            documentId: id(),
            position: 0,
          },
        },
        tableName: "document_fragments",
      },
    ]);

    await adapter.deleteMemories([documentId]);

    expect(await adapter.getMemoriesByIds([documentId, fragmentId])).toEqual(
      [],
    );
    const remaining = await adapter.getMemories({
      roomId,
      tableName: "document_fragments",
    });
    expect(remaining.map((row) => row.id)).toEqual([unrelatedId]);
  });

  it("stores memories without a uniqueness flag as unique, like plugin-sql", async () => {
    const adapter = await open();
    const plain = (text: string) => ({ ...memory(text), embedding: undefined });
    const created = plain("created");
    const duplicate = plain("duplicate");
    const published = plain("published");
    await adapter.createMemories([
      { memory: created, tableName: "messages" },
      { memory: duplicate, tableName: "messages", unique: false },
    ]);
    await adapter.publishMessageContentSegments({
      mode: "create",
      parent: published,
      segments: [],
    });

    const unique = await adapter.getMemories({
      roomId,
      unique: true,
      tableName: "messages",
    });
    expect(unique.map((row) => row.id).sort()).toEqual(
      [created.id, published.id].sort(),
    );
    expect(
      await adapter.countMemories({
        roomIds: [roomId],
        unique: true,
        tableName: "messages",
      }),
    ).toBe(2);
  });

  it("pages tasks by creation time when the later id sorts first", async () => {
    const adapter = await open();
    const earlyId = "ffffffff-ffff-4fff-8fff-ffffffffffff" as UUID;
    const lateId = "00000000-0000-4000-8000-000000000001" as UUID;
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_700_000_000_000);
    now.mockReturnValueOnce(1_700_000_000_005);
    try {
      await adapter.createTasks([
        { id: earlyId, name: "early", agentId, tags: ["queue"], metadata: {} },
      ]);
      await adapter.createTasks([
        { id: lateId, name: "late", agentId, tags: ["queue"], metadata: {} },
      ]);
    } finally {
      now.mockRestore();
    }
    const page = await adapter.getTasks({ agentIds: [agentId], limit: 1 });
    expect(page.map((task) => task.id)).toEqual([earlyId]);
    expect(page[0]?.createdAt).toBe(1_700_000_000_000);
  });

  it("returns every eligible vector when match_threshold is omitted or zero", async () => {
    const adapter = await open();
    await adapter.ensureEmbeddingDimension(3);
    const close = {
      ...memory("close"),
      embedding: [1, 0, 0],
    };
    const distant = {
      ...memory("distant"),
      embedding: [0, 1, 0],
    };
    await adapter.createMemories([
      { memory: close, tableName: "messages" },
      { memory: distant, tableName: "messages" },
    ]);

    const omitted = await adapter.searchMemories({
      tableName: "messages",
      embedding: [1, 0, 0],
      roomId,
    });
    expect(omitted.map((row) => row.id).sort()).toEqual(
      [close.id, distant.id].sort(),
    );

    const zero = await adapter.searchMemories({
      tableName: "messages",
      embedding: [1, 0, 0],
      roomId,
      match_threshold: 0,
    });
    expect(zero.map((row) => row.id).sort()).toEqual(
      [close.id, distant.id].sort(),
    );

    const strict = await adapter.searchMemories({
      tableName: "messages",
      embedding: [1, 0, 0],
      roomId,
      match_threshold: 0.99,
    });
    expect(strict.map((row) => row.id)).toEqual([close.id]);
  });

  it("preserves complete sources and the selected embedding space across restarts", async () => {
    const adapter = await open();
    const record = memory(
      "complete source before representation selection ".repeat(1000),
    );
    await adapter.ensureEmbeddingDimension(3);
    await adapter.createMemories([{ memory: record, tableName: "messages" }]);
    expect(await adapter.ensureEmbeddingSpace("fixture:space-v1")).toContain(
      record.id,
    );
    expect((await adapter.getMemoriesByIds([record.id]))[0]).toMatchObject({
      content: record.content,
    });
    expect(
      (await adapter.getMemoriesByIds([record.id]))[0].embedding,
    ).toBeUndefined();
    await adapter.updateMemories([{ id: record.id, embedding: [1, 0, 0] }]);
    await adapter.close();
    const reopened = await open();
    expect(
      await reopened.ensureEmbeddingSpace("fixture:space-v1"),
    ).not.toContain(record.id);
    expect((await reopened.getMemoriesByIds([record.id]))[0].embedding).toEqual(
      [1, 0, 0],
    );
    await expect(
      reopened.ensureEmbeddingSpace("fixture:space-v2"),
    ).rejects.toMatchObject({ code: "EMBEDDING_SPACE_CHANGED" });
    await expect(reopened.ensureEmbeddingDimension(4)).rejects.toMatchObject({
      code: "EMBEDDING_SPACE_CHANGED",
    });
  });

  it("finds a component by entity and type when world and source are omitted", async () => {
    const adapter = await open();
    const worldId = id();
    const componentId = id();
    await adapter.createAgents([{ id: agentId, name: "Form agent" }]);
    await adapter.createEntities([{ id: entityId, agentId, names: ["User"] }]);
    await adapter.createWorlds([{ id: worldId, name: "Forms", agentId }]);
    await adapter.createComponents([
      {
        id: componentId,
        entityId,
        agentId,
        roomId,
        worldId,
        sourceEntityId: agentId,
        type: "form_session",
        createdAt: 1,
        data: { status: "active" },
      },
    ]);

    const [omitted, sameWorld, otherWorld, otherSource] =
      await adapter.getComponentsByNaturalKeys([
        { entityId, type: "form_session" },
        { entityId, type: "form_session", worldId },
        { entityId, type: "form_session", worldId: id() },
        { entityId, type: "form_session", sourceEntityId: id() },
      ]);
    expect(omitted?.id).toBe(componentId);
    expect(sameWorld?.id).toBe(componentId);
    expect(otherWorld).toBeNull();
    expect(otherSource).toBeNull();
  });

  it("reopens runtime records, full content and semantic search without an in-memory singleton", async () => {
    const adapter = await open();
    const worldId = id();
    const componentId = id();
    const taskId = id();
    const record = memory("complete durable conversation ".repeat(5000));
    await adapter.ensureEmbeddingDimension(3);
    await adapter.createAgents([{ id: agentId, name: "Durable agent" }]);
    await adapter.createEntities([
      { id: entityId, agentId, names: ["Senior"] },
    ]);
    await adapter.createWorlds([{ id: worldId, name: "Private", agentId }]);
    await adapter.createRooms([
      { id: roomId, agentId, worldId, type: ChannelType.DM, source: "test" },
    ]);
    await adapter.createComponents([
      {
        id: componentId,
        entityId,
        agentId,
        roomId,
        worldId,
        sourceEntityId: agentId,
        type: "profile",
        createdAt: 1,
        data: { name: "Senior" },
      },
    ]);
    await adapter.createTasks([
      {
        id: taskId,
        agentId,
        name: "Check in",
        description: "Synthetic reminder",
        tags: [],
      },
    ]);
    await adapter.setCaches([
      { key: "consent", value: { accepted: true, history: ["v1"] } },
    ]);
    await adapter.createMemories([{ memory: record, tableName: "messages" }]);
    await adapter.close();
    const reopened = await open();
    expect((await reopened.getAgentsByIds([agentId]))[0].name).toBe(
      "Durable agent",
    );
    expect((await reopened.getEntitiesByIds([entityId]))[0].names).toEqual([
      "Senior",
    ]);
    expect((await reopened.getRoomsByIds([roomId]))[0].worldId).toBe(worldId);
    expect((await reopened.getComponentsByIds([componentId]))[0].data).toEqual({
      name: "Senior",
    });
    expect((await reopened.getTasksByIds([taskId]))[0].name).toBe("Check in");
    expect((await reopened.getCaches(["consent"])).get("consent")).toEqual({
      accepted: true,
      history: ["v1"],
    });
    expect((await reopened.getMemoriesByIds([record.id]))[0].content.text).toBe(
      record.content.text,
    );
    expect(
      (
        await reopened.searchMemories({
          tableName: "messages",
          embedding: [1, 0, 0],
          roomId,
        })
      ).map((m) => m.id),
    ).toContain(record.id);
  });

  it("deletes an entity's components, memberships, memories, relationships and logs with it", async () => {
    const adapter = await open();
    const worldId = id();
    const otherEntityId = id();
    const owned = id();
    const sourced = id();
    const unrelated = id();
    await adapter.createAgents([{ id: agentId, name: "Contacts agent" }]);
    await adapter.createEntities([
      { id: entityId, agentId, names: ["Pat"] },
      { id: otherEntityId, agentId, names: ["Sam"] },
    ]);
    await adapter.createWorlds([{ id: worldId, name: "Contacts", agentId }]);
    await adapter.createRooms([
      { id: roomId, agentId, worldId, type: ChannelType.DM, source: "test" },
    ]);
    await adapter.createRoomParticipants([entityId, otherEntityId], roomId);
    const component = (
      componentId: UUID,
      owner: UUID,
      sourceEntityId: UUID,
    ) => ({
      id: componentId,
      entityId: owner,
      agentId,
      roomId,
      worldId,
      sourceEntityId,
      type: "contact_info",
      createdAt: 1,
      data: {},
    });
    await adapter.createComponents([
      component(owned, entityId, agentId),
      component(sourced, otherEntityId, entityId),
      component(unrelated, otherEntityId, agentId),
    ]);

    const deletedMemory = { ...memory("from the deleted contact") };
    const keptMemory = {
      ...memory("from the other contact"),
      entityId: otherEntityId,
    };
    await adapter.ensureEmbeddingDimension(3);
    await adapter.createMemories([
      { memory: deletedMemory, tableName: "messages" },
      { memory: keptMemory, tableName: "messages" },
    ]);
    await adapter.createRelationships([
      { sourceEntityId: agentId, targetEntityId: entityId, tags: ["friend"] },
      {
        sourceEntityId: entityId,
        targetEntityId: otherEntityId,
        tags: ["peer"],
      },
      {
        sourceEntityId: agentId,
        targetEntityId: otherEntityId,
        tags: ["kept"],
      },
    ]);
    await adapter.createLogs([
      { body: {}, entityId, roomId, type: "contact-log" },
      { body: {}, entityId: otherEntityId, roomId, type: "contact-log" },
    ]);

    await adapter.deleteEntities([entityId]);

    expect(await adapter.getEntitiesByIds([entityId])).toEqual([]);
    expect(
      (await adapter.getComponentsByIds([owned, sourced, unrelated])).map(
        (row) => row.id,
      ),
    ).toEqual([unrelated]);
    expect(await adapter.getRoomsForParticipants([entityId])).toEqual([]);
    expect(await adapter.getRoomsForParticipants([otherEntityId])).toEqual([
      roomId,
    ]);
    expect(
      (await adapter.getMemoriesByIds([deletedMemory.id, keptMemory.id])).map(
        (row) => row.id,
      ),
    ).toEqual([keptMemory.id]);
    expect(
      (
        await adapter.getRelationships({ entityIds: [agentId, otherEntityId] })
      ).flatMap((row) => row.tags),
    ).toEqual(["kept"]);
    expect(
      (await adapter.getLogs({ type: "contact-log" })).map(
        (row) => row.entityId,
      ),
    ).toEqual([otherEntityId]);
  });

  it("replaces memory and relationship metadata on update, so keys can be removed", async () => {
    const adapter = await open();
    await adapter.ensureEmbeddingDimension(3);
    await adapter.createAgents([{ id: agentId, name: "Metadata agent" }]);
    await adapter.createEntities([{ id: entityId, agentId, names: ["User"] }]);
    const reply = {
      ...memory("recovered reply"),
      metadata: {
        type: "custom",
        source: "client_chat",
        chatFailureKind: "provider_error",
      },
    } as Memory & { id: UUID };
    await adapter.createMemories([{ memory: reply, tableName: "messages" }]);

    // Reply recovery clears the failure marker and writes the rest back.
    await adapter.updateMemories([
      { id: reply.id, metadata: { type: "custom", source: "client_chat" } },
    ]);
    await adapter.updateMemories([
      { id: reply.id, content: { text: "edited" } },
    ]);

    const [stored] = await adapter.getMemoriesByIds([reply.id]);
    expect(stored?.metadata).toEqual({ type: "custom", source: "client_chat" });
    expect(stored?.content.text).toBe("edited");

    const [relationship] = await adapter.createRelationships([
      {
        sourceEntityId: agentId,
        targetEntityId: entityId,
        tags: ["friend"],
        metadata: { pinned: true, note: "met at conf" },
      },
    ]);
    await adapter.updateRelationships([
      {
        id: relationship as UUID,
        sourceEntityId: agentId,
        targetEntityId: entityId,
        agentId,
        tags: ["friend"],
        metadata: { note: "met at conf" },
      },
    ]);
    const [updated] = await adapter.getRelationshipsByIds([
      relationship as UUID,
    ]);
    expect(updated?.metadata).toEqual({ note: "met at conf" });
  });

  it("rolls back domain records and runtime semantic state in one native transaction", async () => {
    const adapter = await open();
    await adapter.ensureEmbeddingDimension(3);
    const committed = memory("committed before domain change");
    const rejected = memory("rejected domain change");
    await adapter.createMemories([
      { memory: committed, tableName: "messages" },
    ]);
    await expect(
      adapter.recordStore.transaction(async () => {
        await adapter.recordStore.set("plugin_synthetic", "pending", {
          accepted: false,
        });
        await adapter.deleteMemories([committed.id]);
        await adapter.createMemories([
          { memory: rejected, tableName: "messages" },
        ]);
        throw new Error("synthetic domain failure");
      }),
    ).rejects.toMatchObject({
      code: "SQLITE_TRANSACTION_FAILED",
      cause: { message: "synthetic domain failure" },
    });
    expect(
      await adapter.recordStore.get("plugin_synthetic", "pending"),
    ).toBeNull();
    expect(
      (
        await adapter.searchMemories({
          tableName: "messages",
          embedding: [1, 0, 0],
          roomId,
        })
      ).map((entry) => entry.id),
    ).toEqual([committed.id]);
    expect(await adapter.getMemoriesByIds([rejected.id])).toEqual([]);
  });

  it("rolls back multi-method changes and restores the transient vector index before another reader", async () => {
    const adapter = await open();
    await adapter.ensureEmbeddingDimension(3);
    const original = memory("committed");
    const rolledBack = memory("rollback");
    await adapter.createMemories([{ memory: original, tableName: "messages" }]);
    await expect(
      adapter.transaction(async (tx) => {
        await tx.createMemories([
          { memory: rolledBack, tableName: "messages" },
        ]);
        await tx.setCaches([{ key: "uncommitted", value: true }]);
        throw new Error("abort synthetic transaction");
      }),
    ).rejects.toMatchObject({ code: "SQLITE_TRANSACTION_FAILED" });
    expect(await adapter.getMemoriesByIds([rolledBack.id])).toEqual([]);
    expect((await adapter.getCaches(["uncommitted"])).size).toBe(0);
    expect(
      (
        await adapter.searchMemories({
          tableName: "messages",
          embedding: [1, 0, 0],
        })
      ).map((m) => m.id),
    ).toEqual([original.id]);
  });

  it("deletes a room's components and logs with it", async () => {
    const adapter = await open();
    const worldId = id();
    const otherRoomId = id();
    await adapter.createAgents([{ id: agentId, name: "Conversation agent" }]);
    await adapter.createEntities([{ id: entityId, agentId, names: ["User"] }]);
    await adapter.createWorlds([{ id: worldId, name: "Chats", agentId }]);
    await adapter.createRooms([
      { id: roomId, agentId, worldId, type: ChannelType.DM, source: "test" },
      {
        id: otherRoomId,
        agentId,
        worldId,
        type: ChannelType.DM,
        source: "test",
      },
    ]);
    const component = (componentId: UUID, room: UUID) => ({
      id: componentId,
      entityId,
      agentId,
      roomId: room,
      worldId,
      sourceEntityId: agentId,
      type: "room_state",
      createdAt: 1,
      data: {},
    });
    const deleted = id();
    const kept = id();
    await adapter.createComponents([
      component(deleted, roomId),
      component(kept, otherRoomId),
    ]);
    await adapter.createLogs([
      { body: {}, entityId, roomId, type: "conversation-log" },
      { body: {}, entityId, roomId: otherRoomId, type: "conversation-log" },
    ]);

    await adapter.deleteRooms([roomId]);

    expect(
      (await adapter.getComponentsByIds([deleted, kept])).map((row) => row.id),
    ).toEqual([kept]);
    expect(
      (await adapter.getLogs({ type: "conversation-log" })).map(
        (row) => row.roomId,
      ),
    ).toEqual([otherRoomId]);
  });

  it("keeps outside reads behind an awaiting transaction and supports nested rollback", async () => {
    const adapter = await open();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = adapter.transaction(async (tx) => {
      await tx.setCaches([{ key: "visible", value: "committed" }]);
      await expect(
        tx.transaction(async (nested) => {
          await nested.setCaches([{ key: "nested", value: "must disappear" }]);
          throw new Error("nested abort");
        }),
      ).rejects.toMatchObject({ code: "SQLITE_TRANSACTION_FAILED" });
      entered();
      await gate;
    });
    await started;
    let observed = false;
    const reader = adapter.getCaches(["visible", "nested"]).then((value) => {
      observed = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(observed).toBe(false);
    release();
    await transaction;
    expect(await reader).toEqual(new Map([["visible", "committed"]]));
  });

  it("serializes concurrent increments and rejects overlapping savepoints without partial commit", async () => {
    const adapter = await open();
    await adapter.setCaches([{ key: "counter", value: 0 }]);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        adapter.transaction(async (tx) => {
          const value = (await tx.getCaches<number>(["counter"])).get(
            "counter",
          );
          if (value === undefined) throw new Error("counter missing");
          await new Promise<void>((resolve) => setImmediate(resolve));
          await tx.setCaches([{ key: "counter", value: value + 1 }]);
        }),
      ),
    );
    expect((await adapter.getCaches<number>(["counter"])).get("counter")).toBe(
      20,
    );
    await expect(
      adapter.transaction(async (tx) => {
        await Promise.all([
          tx.transaction(async (nested) => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            await nested.setCaches([{ key: "overlap", value: true }]);
          }),
          tx.transaction(async (nested) => {
            await nested.setCaches([{ key: "sibling", value: true }]);
          }),
        ]);
      }),
    ).rejects.toMatchObject({ code: "SQLITE_TRANSACTION_OVERLAP" });
    expect((await adapter.getCaches(["overlap", "sibling"])).size).toBe(0);
    await adapter.close();
    expect(
      (await (await open()).getCaches<number>(["counter"])).get("counter"),
    ).toBe(20);
  });

  it("settles hidden ingestion records with mutation authority across restart", async () => {
    const adapter = await open();
    await adapter.ensureEmbeddingDimension(3);
    const pending = memory("complete pending document");
    const pendingMetadata = {
      type: MemoryType.DOCUMENT,
      scope: "owner-private" as const,
      ingestionState: "pending",
      ingestionAttemptId: id(),
      documentRevision: 0,
    };
    pending.metadata = pendingMetadata;
    await adapter.createMemories([{ memory: pending, tableName: "documents" }]);
    const expected = readDocumentMutationSnapshot(pending);
    if (!expected) throw new Error("Missing pending document snapshot");
    const context = {
      agentId,
      requesterEntityId: agentId,
      requesterRole: "OWNER" as const,
      requesterRoomIds: [],
      documentId: pending.id,
    };
    expect(await adapter.getDocument(context)).toBeNull();
    const ready = {
      ...pending,
      metadata: { ...pendingMetadata, ingestionState: "ready" },
    };
    expect(
      (
        await adapter.compareAndSwapDocument({
          ...context,
          requesterEntityId: entityId,
          requesterRole: "USER",
          expected,
          replacement: ready,
        })
      ).status,
    ).not.toBe("updated");
    expect(
      (
        await adapter.compareAndSwapDocument({
          ...context,
          expected,
          replacement: ready,
        })
      ).status,
    ).toBe("updated");
    expect(
      (
        await adapter.compareAndSwapDocument({
          ...context,
          expected,
          replacement: ready,
        })
      ).status,
    ).toBe("conflict");
    await adapter.close();
    const reopened = await open();
    expect((await reopened.getDocument(context))?.content.text).toBe(
      pending.content.text,
    );
    const readySnapshot = readDocumentMutationSnapshot(ready);
    if (!readySnapshot) throw new Error("Missing ready document snapshot");
    const failed = {
      ...ready,
      metadata: { ...ready.metadata, ingestionState: "failed" },
    };
    expect(
      (
        await reopened.compareAndSwapDocument({
          ...context,
          expected: readySnapshot,
          replacement: failed,
        })
      ).status,
    ).toBe("updated");
    expect(await reopened.getDocument(context)).toBeNull();
    const failedSnapshot = readDocumentMutationSnapshot(failed);
    if (!failedSnapshot) throw new Error("Missing failed document snapshot");
    expect(
      (
        await reopened.deleteDocumentWithSnapshot({
          ...context,
          expected: readySnapshot,
        })
      ).status,
    ).toBe("conflict");
    expect(
      (
        await reopened.deleteDocumentWithSnapshot({
          ...context,
          expected: failedSnapshot,
        })
      ).status,
    ).toBe("deleted");
    expect(await reopened.getMemoriesByIds([pending.id])).toEqual([]);
  });

  it("restores document permissions and commits only one concurrent revision", async () => {
    const adapter = await open();
    const document = memory("private original");
    await adapter.createRooms([
      { id: roomId, agentId, source: "test", type: ChannelType.GROUP },
    ]);
    await adapter.createRoomParticipants([entityId], roomId);
    const documentMetadata = {
      type: MemoryType.DOCUMENT,
      timestamp: 1,
      scope: "user-private" as const,
      scopedToEntityId: entityId,
      documentRevision: 0,
    };
    document.metadata = documentMetadata;
    await adapter.ensureEmbeddingDimension(3);
    await adapter.createMemories([
      { memory: document, tableName: "documents" },
    ]);
    const expected = readDocumentMutationSnapshot(document);
    if (!expected) throw new Error("document snapshot missing");
    const context = {
      agentId,
      requesterEntityId: entityId,
      requesterRole: "USER" as const,
      requesterRoomIds: [roomId],
    };
    const results = await Promise.all(
      ["first", "second"].map((text) => {
        const replacementMetadata = {
          ...documentMetadata,
          documentRevision: 1,
        };
        return adapter.compareAndSwapDocument({
          ...context,
          documentId: document.id,
          expected,
          replacement: {
            ...document,
            content: { text },
            metadata: replacementMetadata,
          },
        });
      }),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      "conflict",
      "updated",
    ]);
    await adapter.close();
    const reopened = await open();
    expect(
      (await reopened.getDocument({ ...context, documentId: document.id }))
        ?.content.text,
    ).toBe("first");
    expect(
      await reopened.getDocument({
        ...context,
        requesterEntityId: id(),
        documentId: document.id,
      }),
    ).toBeNull();
    expect(
      await reopened.compareAndSwapDocument({
        ...context,
        documentId: document.id,
        expected,
        replacement: document,
      }),
    ).toEqual({ status: "conflict" });
    const granteeId = id();
    await reopened.createEntities([
      { id: granteeId, agentId, names: ["Allowed reader"] },
    ]);
    const current = await reopened.getDocument({
      ...context,
      documentId: document.id,
    });
    if (!current) throw new Error("document missing");
    const grantSnapshot = readDocumentMutationSnapshot(current);
    if (!grantSnapshot) throw new Error("grant snapshot missing");
    expect(
      await reopened.updateDocumentDirectGrants({
        ...context,
        requesterRole: "OWNER",
        documentId: document.id,
        expected: grantSnapshot,
        directGrantEntityIds: [granteeId],
      }),
    ).toMatchObject({ status: "updated" });
    await reopened.close();
    const granted = await open();
    expect(
      (
        await granted.getDocument({
          ...context,
          requesterEntityId: granteeId,
          requesterRoomIds: [],
          documentId: document.id,
        })
      )?.content.text,
    ).toBe("first");
    expect(
      await granted.updateDocumentDirectGrants({
        ...context,
        requesterRole: "OWNER",
        documentId: document.id,
        expected: grantSnapshot,
        directGrantEntityIds: [],
      }),
    ).toEqual({ status: "conflict" });
  });

  it("rolls back role changes with their audit and persists pairing, participants and relationships", async () => {
    const adapter = await open();
    const worldId = id();
    const metadata = {
      roles: { [entityId]: Role.MEMBER },
      [WORLD_METADATA_REVISION_KEY]: 0,
    };
    await adapter.createWorlds([
      { id: worldId, agentId, name: "Roles", metadata },
    ]);
    const initialMetadata = metadata;
    const request = {
      worldId,
      expectedMetadata: initialMetadata,
      replacementMetadata: { roles: { [entityId]: "ADMIN" } },
      audit: {
        actorEntityId: agentId,
        targetEntityId: entityId,
        previousRole: "USER",
        newRole: "ADMIN",
        source: "manual" as const,
        roomId,
      },
    };
    await expect(
      adapter.transaction(async (tx) => {
        if (!tx.compareAndSwapWorldMetadata)
          throw new Error("CAS capability missing");
        expect(await tx.compareAndSwapWorldMetadata(request)).toEqual({
          status: "updated",
        });
        throw new Error("rollback role grant");
      }),
    ).rejects.toMatchObject({ code: "SQLITE_TRANSACTION_FAILED" });
    expect(await adapter.getLogs({ type: ROLE_WRITE_AUDIT_LOG_TYPE })).toEqual(
      [],
    );
    expect((await adapter.getWorldsByIds([worldId]))[0].metadata).toEqual(
      initialMetadata,
    );
    expect(await adapter.compareAndSwapWorldMetadata(request)).toEqual({
      status: "updated",
    });
    const pairedId = id();
    const date = new Date("2026-09-22T00:00:00Z");
    await adapter.createPairingRequests([
      {
        id: pairedId,
        agentId,
        channel: "telegram",
        senderId: "synthetic",
        code: "ABCDEF",
        createdAt: date,
        lastSeenAt: date,
      },
    ]);
    await adapter.createPairingAllowlistEntries([
      {
        id: id(),
        agentId,
        channel: "telegram",
        senderId: "synthetic",
        createdAt: date,
      },
    ]);
    await adapter.createRoomParticipants([entityId], roomId);
    const [relationship] = await adapter.createRelationships([
      {
        sourceEntityId: agentId,
        targetEntityId: entityId,
        tags: ["caregiver"],
      },
    ]);
    await adapter.close();
    const reopened = await open();
    const logs = await reopened.getLogs({ type: ROLE_WRITE_AUDIT_LOG_TYPE });
    expect(logs).toHaveLength(1);
    expect(logs[0].createdAt).toBeInstanceOf(Date);
    expect(
      (await reopened.getWorldsByIds([worldId]))[0].metadata?.roles?.[entityId],
    ).toBe("ADMIN");
    expect(
      (await reopened.getPairingRequests([{ agentId, channel: "telegram" }]))[0]
        .requests[0].createdAt,
    ).toEqual(date);
    expect(
      (
        await reopened.getPairingAllowlists([{ agentId, channel: "telegram" }])
      )[0].entries[0].senderId,
    ).toBe("synthetic");
    expect(await reopened.areRoomParticipants([{ roomId, entityId }])).toEqual([
      true,
    ]);
    expect(
      (await reopened.getRelationshipsByIds([relationship]))[0].tags,
    ).toEqual(["caregiver"]);
  });

  it("persists task claims and deadlines while rejecting stale embedding work after restart", async () => {
    const adapter = await open();
    await adapter.ensureEmbeddingDimension(3);
    const record = memory("before correction");
    await adapter.createMemories([{ memory: record, tableName: "messages" }]);
    const expected = { agentId, entityId, roomId, text: "before correction" };
    await adapter.updateMemories([
      {
        id: record.id,
        content: { text: "corrected 🧡\n" },
        embedding: [0, 1, 0],
      },
    ]);
    const taskId = id();
    await adapter.createTasks([
      {
        id: taskId,
        agentId,
        name: "durable task",
        tags: ["queue"],
        dueAt: 1234567890123n,
        metadata: { status: "pending" },
      },
    ]);
    const claims = await Promise.all(
      ["worker-a", "worker-b"].map((worker) =>
        adapter.updatePendingTask(taskId, {
          metadata: {
            status: "executing",
            leaseOwner: worker,
            leaseExpiresAt: 1234567890999,
          },
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    await adapter.patchTaskMetadata(taskId, {
      set: { confirmed: true },
      unset: ["leaseExpiresAt"],
    });
    await adapter.close();
    const reopened = await open();
    expect(
      await reopened.updateMemoryEmbedding({
        id: record.id,
        expected,
        embedding: [1, 0, 0],
      }),
    ).toBe(false);
    const [task] = await reopened.getTasksByIds([taskId]);
    expect(task.dueAt).toBe(1234567890123n);
    expect(task.metadata).toMatchObject({
      status: "executing",
      leaseOwner: "worker-a",
      confirmed: true,
    });
    expect(task.metadata).not.toHaveProperty("leaseExpiresAt");
    expect(
      (
        await reopened.searchMemories({
          tableName: "messages",
          roomId,
          embedding: [0, 1, 0],
          match_threshold: 0.99,
        })
      ).map((row) => row.id),
    ).toEqual([record.id]);
    await reopened.deleteMemories([record.id]);
    expect(
      await reopened.updateMemoryEmbedding({
        id: record.id,
        expected: { ...expected, text: "corrected 🧡\n" },
        embedding: [0, 1, 0],
      }),
    ).toBe(false);
  });

  it("pages same-millisecond logs in UUID order without repeating a row", async () => {
    const adapter = await open();
    const storage = await adapter.getConnection();
    const createdAt = new Date("2026-08-20T16:00:00.000Z");
    const lowerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
    const upperId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
    // Storage lists records by ascending id. A time-only sort keeps that
    // order, so the lower id would occupy the first page.
    for (const logId of [lowerId, upperId]) {
      await storage.set("logs", logId, {
        id: logId,
        entityId,
        roomId,
        type: "export-page",
        body: { logId },
        createdAt,
      });
    }
    const first = await adapter.getLogs({
      type: "export-page",
      limit: 1,
      offset: 0,
    });
    const second = await adapter.getLogs({
      type: "export-page",
      limit: 1,
      offset: 1,
    });
    expect(first.map((log) => log.id)).toEqual([upperId]);
    expect(second.map((log) => log.id)).toEqual([lowerId]);
    expect(compareMemoryIds(upperId, lowerId)).toBeGreaterThan(0);
  });

  it("persists audit payloads and retention deletions without leaking between per-agent files", async () => {
    const adapter = await open();
    const other = await open("other.sqlite", id());
    const otherEntity = id();
    await adapter.createLogs([
      {
        entityId,
        roomId,
        type: "inference-route",
        body: {
          source: "route-guard",
          metadata: { attemptId: "synthetic", phase: "dispatch_intent" },
        },
      },
      {
        entityId: otherEntity,
        roomId,
        type: "inference-route",
        body: {
          source: "route-guard",
          metadata: { attemptId: "other", phase: "denied" },
        },
      },
    ]);
    const [own] = await adapter.getLogs({ entityId, type: "inference-route" });
    expect(own.body).toEqual({
      source: "route-guard",
      metadata: { attemptId: "synthetic", phase: "dispatch_intent" },
    });
    expect(await other.getLogs({ type: "inference-route" })).toEqual([]);
    const storage = await adapter.getConnection();
    await storage.set("cache", "expired", {
      value: "must disappear",
      expiresAt: Date.now() - 1,
    });
    await adapter.setCaches([
      {
        key: "rich",
        value: { date: new Date(1), missing: undefined, list: [1, null, "🧡"] },
      },
    ]);
    if (!own.id) throw new Error("audit id missing");
    await adapter.deleteLogs([own.id]);
    await adapter.close();
    const reopened = await open();
    expect(await reopened.getLogsByIds([own.id])).toEqual([]);
    expect(await reopened.getLogs({ entityId })).toEqual([]);
    expect(
      (await reopened.getLogs({ entityId: otherEntity }))[0].createdAt,
    ).toBeInstanceOf(Date);
    expect((await reopened.getCaches(["expired"])).size).toBe(0);
    expect((await reopened.getCaches(["rich"])).get("rich")).toEqual({
      date: new Date(1),
      missing: undefined,
      list: [1, null, "🧡"],
    });
  });

  it("rolls back a failed batch even when its enclosing transaction handles the error", async () => {
    const adapter = await open();
    const duplicate = id();
    await adapter.createWorlds([{ id: duplicate, agentId, name: "existing" }]);
    const partial = id();
    await adapter.transaction(async (tx) => {
      await expect(tx.close()).rejects.toMatchObject({
        code: "SQLITE_LIFECYCLE_IN_TRANSACTION",
      });
      await expect(
        tx.createWorlds([
          { id: partial, agentId, name: "partial" },
          { id: duplicate, agentId, name: "duplicate" },
        ]),
      ).rejects.toMatchObject({ code: "WORLD_ALREADY_EXISTS" });
      await tx.setCaches([{ key: "handled", value: true }]);
    });
    expect(await adapter.getWorldsByIds([partial])).toEqual([]);
    expect((await adapter.getCaches(["handled"])).get("handled")).toBe(true);
  });

  it("persists connector credentials and consumes OAuth state exactly once across restart", async () => {
    const adapter = await open();
    const account = await adapter.upsertConnectorAccount({
      provider: "google",
      accountKey: "synthetic-account",
      agentId,
    });
    await adapter.setConnectorAccountCredentialRef({
      accountId: account.id,
      credentialType: "oauth",
      vaultRef: "vault://synthetic",
    });
    await adapter.createOAuthFlowState({
      provider: "google",
      agentId,
      state: "synthetic-nonce",
      ttlMs: 60000,
    });
    await adapter.close();
    const reopened = await open();
    expect((await reopened.listConnectorAccounts({ agentId }))[0].id).toBe(
      account.id,
    );
    expect(
      (
        await reopened.getConnectorAccountCredentialRef({
          accountId: account.id,
          credentialType: "oauth",
        })
      )?.vaultRef,
    ).toBe("vault://synthetic");
    const results = await Promise.all([
      reopened.consumeOAuthFlowState({
        state: "synthetic-nonce",
        agentId,
        provider: "google",
      }),
      reopened.consumeOAuthFlowState({
        state: "synthetic-nonce",
        agentId,
        provider: "google",
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await reopened.close();
    expect(
      await (await open()).consumeOAuthFlowState({
        state: "synthetic-nonce",
        agentId,
        provider: "google",
      }),
    ).toBeNull();
  });

  it("persists OAuth invalidation and refuses expired or wrong-provider state", async () => {
    const adapter = await open();
    await adapter.createOAuthFlowState({
      agentId,
      provider: "google",
      state: "expired",
      expiresAt: 1,
    });
    await adapter.createOAuthFlowState({
      agentId,
      provider: "google",
      state: "revoked",
      ttlMs: 60000,
    });
    await adapter.createOAuthFlowState({
      agentId,
      provider: "google",
      state: "provider-bound",
      ttlMs: 60000,
    });
    expect(
      await adapter.consumeOAuthFlowState({
        agentId,
        provider: "microsoft",
        state: "provider-bound",
      }),
    ).toBeNull();
    expect(
      await adapter.deleteOAuthFlowState({
        agentId,
        provider: "google",
        state: "revoked",
      }),
    ).toBe(true);
    await adapter.close();
    const reopened = await open();
    expect(
      await reopened.consumeOAuthFlowState({
        agentId,
        provider: "google",
        state: "expired",
      }),
    ).toBeNull();
    expect(
      await reopened.consumeOAuthFlowState({
        agentId,
        provider: "google",
        state: "revoked",
      }),
    ).toBeNull();
    expect(
      await reopened.consumeOAuthFlowState({
        agentId,
        provider: "google",
        state: "provider-bound",
      }),
    ).not.toBeNull();
  });

  it("restores a standalone backup and rejects conflicting owners and unsupported schemas", async () => {
    const adapter = await open();
    await adapter.setCaches([{ key: "backup", value: { bytes: "durable" } }]);
    await adapter.backup(join(directory, "backup.sqlite"));
    const restored = await open("backup.sqlite");
    expect((await restored.getCaches(["backup"])).get("backup")).toEqual({
      bytes: "durable",
    });
    const competing = new SQLiteStorage(
      join(directory, "agent.sqlite"),
      agentId,
    );
    await expect(competing.init()).rejects.toMatchObject({
      code: "SQLITE_OPEN_FAILED",
    });
    await adapter.close();
    await expect(open("agent.sqlite", id())).rejects.toMatchObject({
      code: "SQLITE_OPEN_FAILED",
    });
    await expect(
      restored.runPluginMigrations([
        { name: "postgres-only", schema: { tables: [] } },
      ]),
    ).rejects.toMatchObject({ code: "SQLITE_PLUGIN_SCHEMA_UNSUPPORTED" });
  });
  it("denies cross-agent writes in batches and transactions, preserving the complete batch", async () => {
    const adapter = await open();
    const foreign = id();
    await expect(
      adapter.createAgents([
        { id: agentId, name: "owner" },
        { id: foreign, name: "other" },
      ]),
    ).rejects.toMatchObject({ code: "SQLITE_AGENT_MISMATCH" });
    expect(await adapter.getAgents()).toEqual([]);
    await expect(
      adapter.transaction(async (tx) =>
        tx.upsertConnectorAccount({
          provider: "test",
          accountKey: "foreign",
          agentId: foreign,
        }),
      ),
    ).rejects.toMatchObject({ code: "SQLITE_AGENT_MISMATCH" });
    await expect(
      adapter.createMemories([
        {
          memory: { ...memory("foreign"), agentId: foreign },
          tableName: "messages",
        },
      ]),
    ).rejects.toMatchObject({ code: "SQLITE_AGENT_MISMATCH" });
    expect(await adapter.listConnectorAccounts()).toEqual([]);
  });

  it("uses native cross-process locking and recovers after an uncommitted writer exits", async () => {
    const adapter = await open();
    await adapter.setCaches([{ key: "stable", value: "committed" }]);
    const path = join(directory, "agent.sqlite");
    const locked = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {DatabaseSync} from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      try { db.prepare('SELECT * FROM records').all(); process.exit(2); }
      catch (error) { if (!String(error).includes('locked')) throw error; process.exit(0); }
    `,
        path,
      ],
      { encoding: "utf8" },
    );
    expect(locked.status, locked.stderr).toBe(0);
    await adapter.close();
    const crashed = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {DatabaseSync} from 'node:sqlite';
      import {serialize} from 'node:v8';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO records(collection,id,data) VALUES(?,?,?)').run('cache','crash',serialize({value:'uncommitted'}));
      process.exit(9);
    `,
        path,
      ],
      { encoding: "utf8" },
    );
    expect(crashed.status, crashed.stderr).toBe(9);
    const reopened = await open();
    expect((await reopened.getCaches(["stable", "crash"])).get("stable")).toBe(
      "committed",
    );
    expect((await reopened.getCaches(["crash"])).has("crash")).toBe(false);
  });
});

it("rejects a different lifecycle agent scope before invoking the callback", async () => {
  const adapter = await open();
  let called = false;
  await expect(
    adapter.withAgentScope(id(), async () => {
      called = true;
    }),
  ).rejects.toMatchObject({ code: "SQLITE_AGENT_MISMATCH" });
  expect(called).toBe(false);
  await adapter.withAgentScope(agentId, (scoped) =>
    scoped.setCaches([{ key: "scope-proof", value: "owner" }]),
  );
  expect((await adapter.getCaches(["scope-proof"])).get("scope-proof")).toBe(
    "owner",
  );
});

it("enumerates persisted memory types after reopening the owner file", async () => {
  const adapter = await open();
  await adapter.createAgents([{ id: agentId, name: "Inventory owner" }]);
  await adapter.createEntities([{ id: entityId, agentId, names: ["Owner"] }]);
  await adapter.createRooms([
    { id: roomId, agentId, source: "test", type: ChannelType.DM },
  ]);
  await adapter.createMemories([
    {
      tableName: "plugin_unlisted",
      memory: {
        id: id(),
        agentId,
        entityId,
        roomId,
        content: { text: "Persistent inventory" },
      },
    },
  ]);
  expect(await adapter.listMemoryTypes()).toEqual(["plugin_unlisted"]);
  await adapter.close();
  const reopened = await open();
  expect(await reopened.listMemoryTypes()).toEqual(["plugin_unlisted"]);
});

it("cache CAS has one winner, preserves null and rejects lossy values", async () => {
  const adapter = await open();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, writer) =>
      adapter.compareAndSetCache("claim", undefined, { writer }),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await adapter.compareAndSetCache("absent", null, 1)).toBe(false);
  expect(await adapter.compareAndSetCache("null", undefined, null)).toBe(true);
  expect(await adapter.compareAndSetCache("null", null, { b: 2, a: 1 })).toBe(
    true,
  );
  expect(await adapter.compareAndSetCache("null", { a: 1, b: 2 }, "done")).toBe(
    true,
  );
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let invoked = false;
  const accessor = {
    get value() {
      invoked = true;
      return 1;
    },
  };
  for (const invalid of [
    undefined,
    NaN,
    Infinity,
    1n,
    new Date(),
    Array(2),
    { x: undefined },
    cycle,
    accessor,
    "\u0000",
    "\ud800",
  ]) {
    await expect(
      adapter.compareAndSetCache("invalid", undefined, invalid),
    ).rejects.toMatchObject({ code: "CACHE_CAS_INVALID_VALUE" });
  }
  expect(invoked).toBe(false);
  expect((await adapter.getCaches(["invalid"])).has("invalid")).toBe(false);
  await adapter.close();
  const reopened = await open();
  expect(await reopened.compareAndSetCache("claim", undefined, "replay")).toBe(
    false,
  );
});

it("keeps another agent's worlds out of listing, updates, and metadata swaps", async () => {
  const adapter = await open();
  const ownedId = id();
  const foreignId = id();
  const otherAgentId = id();
  await adapter.createWorlds([{ id: ownedId, agentId, name: "home" }]);
  const storage = await adapter.getConnection();
  await storage.set("worlds", foreignId, {
    id: foreignId,
    agentId: otherAgentId,
    name: "secret",
  });

  expect((await adapter.getAllWorlds()).map((world) => world.id)).toEqual([
    ownedId,
  ]);
  expect(await adapter.getWorldsByIds([foreignId])).toEqual([]);
  await adapter.deleteWorlds([foreignId]);
  expect(await storage.get("worlds", foreignId)).toMatchObject({
    agentId: otherAgentId,
    name: "secret",
  });
  await adapter.updateWorlds([{ id: foreignId, agentId, name: "rewritten" }]);
  await adapter.upsertWorlds([{ id: foreignId, agentId, name: "upserted" }]);
  expect(
    await adapter.compareAndSwapWorldMetadata({
      worldId: foreignId,
      expectedMetadata: {},
      replacementMetadata: { note: "nope" },
    }),
  ).toEqual({ status: "not_found" });
  expect(await storage.get("worlds", foreignId)).toMatchObject({
    id: foreignId,
    agentId: otherAgentId,
    name: "secret",
  });
});

it("keeps another agent's tasks out of name lookup, id lookup, and writes", async () => {
  const adapter = await open();
  const otherAgentId = id();
  const ownedId = id();
  const unscopedId = id();
  const foreignId = id();
  await adapter.createTasks([
    {
      id: ownedId,
      agentId,
      name: "Check in",
      tags: ["queue"],
      metadata: { status: "pending" },
    },
    {
      id: unscopedId,
      name: "Check in",
      tags: ["queue"],
      metadata: { status: "pending" },
    },
  ]);
  const storage = await adapter.getConnection();
  await storage.set("tasks", foreignId, {
    id: foreignId,
    agentId: otherAgentId,
    name: "Check in",
    tags: ["queue"],
    metadata: { status: "pending" },
  });

  const named = await adapter.getTasksByName("Check in");
  expect(named.map((task) => task.id).sort()).toEqual(
    [ownedId, unscopedId].sort(),
  );
  // A row written before create stamped the agent is still this database's.
  const legacyId = id();
  await storage.set("tasks", legacyId, {
    id: legacyId,
    name: "Legacy",
    tags: ["queue"],
    metadata: {},
  });
  const queued = await adapter.getTasks({
    agentIds: [agentId],
    tags: ["queue"],
  });
  expect(queued.map((task) => task.id).sort()).toEqual(
    [ownedId, unscopedId, legacyId].sort(),
  );
  expect(await storage.get("tasks", unscopedId)).toMatchObject({ agentId });
  expect(await adapter.getTasksByIds([foreignId, ownedId])).toEqual([
    expect.objectContaining({ id: ownedId }),
  ]);

  expect(
    await adapter.updatePendingTask(foreignId, {
      metadata: { status: "executing", leaseOwner: "intruder" },
    }),
  ).toBe(false);
  await adapter.updateTasks([
    { id: foreignId, task: { description: "rewritten" } },
  ]);
  expect(
    await adapter.patchTaskMetadata(foreignId, { set: { reason: "nope" } }),
  ).toBe(false);
  await adapter.deleteTasks([foreignId]);

  const foreign = await storage.get("tasks", foreignId);
  expect(foreign).toMatchObject({
    id: foreignId,
    agentId: otherAgentId,
    name: "Check in",
    metadata: { status: "pending" },
  });
  expect(foreign).not.toMatchObject({ description: "rewritten" });
});

it("keeps another agent's rooms out of lookup and world deletion", async () => {
  const adapter = await open();
  const worldId = id();
  const ownedRoom = id();
  const unscopedRoom = id();
  const foreignRoom = id();
  const otherAgentId = id();
  await adapter.createWorlds([{ id: worldId, name: "Shared", agentId }]);
  await adapter.createRooms([
    {
      id: ownedRoom,
      agentId,
      worldId,
      source: "test",
      type: ChannelType.GROUP,
      name: "owned",
    },
    {
      id: unscopedRoom,
      worldId,
      source: "test",
      type: ChannelType.GROUP,
      name: "unscoped",
    },
  ]);
  const storage = await adapter.getConnection();
  await storage.set("rooms", foreignRoom, {
    id: foreignRoom,
    agentId: otherAgentId,
    worldId,
    source: "test",
    type: ChannelType.GROUP,
    name: "foreign",
  });
  await adapter.createRoomParticipants([entityId], ownedRoom);
  await adapter.createRoomParticipants([entityId], unscopedRoom);
  await storage.set("participants", id(), {
    id: id(),
    entityId,
    roomId: foreignRoom,
  });

  const visible = [ownedRoom, unscopedRoom].sort();
  expect(
    (await adapter.getRoomsByIds([foreignRoom, ownedRoom, unscopedRoom]))
      .map((room) => room.id)
      .sort(),
  ).toEqual(visible);
  expect(
    (await adapter.getRoomsByWorlds([worldId])).map((room) => room.id).sort(),
  ).toEqual(visible);
  expect((await adapter.getRoomsForParticipants([entityId])).sort()).toEqual(
    visible,
  );

  await adapter.deleteRoomsByWorldIds([worldId]);
  expect(await storage.get("rooms", foreignRoom)).toMatchObject({
    id: foreignRoom,
    agentId: otherAgentId,
    name: "foreign",
  });
  expect(await storage.get("rooms", ownedRoom)).toBeNull();
  expect(await storage.get("rooms", unscopedRoom)).toBeNull();
});

const LOWER_PAIRING_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const UPPER_PAIRING_ID = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB" as UUID;
const PAIRING_AT = new Date("2026-08-20T16:00:00.000Z");

it("pages newest pairing requests by UUID when the higher id is uppercase", async () => {
  const adapter = await open();
  await adapter.createPairingRequests([
    {
      id: LOWER_PAIRING_ID,
      channel: "telegram",
      agentId,
      senderId: "lower",
      code: "AAAAAAAA",
      createdAt: PAIRING_AT,
      lastSeenAt: PAIRING_AT,
    },
    {
      id: UPPER_PAIRING_ID,
      channel: "telegram",
      agentId,
      senderId: "upper",
      code: "BBBBBBBB",
      createdAt: PAIRING_AT,
      lastSeenAt: PAIRING_AT,
    },
  ]);

  const [page] = await adapter.getPairingRequests([
    {
      channel: "telegram",
      agentId,
      limit: 1,
      offset: 0,
      order: "newest",
    },
  ]);
  expect(page.requests.map((request) => request.id)).toEqual([
    UPPER_PAIRING_ID,
  ]);
});

it("pages newest pairing allowlist entries by UUID when the higher id is uppercase", async () => {
  const adapter = await open();
  await adapter.createPairingAllowlistEntries([
    {
      id: LOWER_PAIRING_ID,
      channel: "telegram",
      agentId,
      senderId: "lower",
      createdAt: PAIRING_AT,
    },
    {
      id: UPPER_PAIRING_ID,
      channel: "telegram",
      agentId,
      senderId: "upper",
      createdAt: PAIRING_AT,
    },
  ]);

  const [page] = await adapter.getPairingAllowlists([
    {
      channel: "telegram",
      agentId,
      limit: 1,
      offset: 0,
      order: "newest",
    },
  ]);
  expect(page.entries.map((entry) => entry.id)).toEqual([UPPER_PAIRING_ID]);
});

it("pages relationships oldest-first when the newer edge has the lower id", async () => {
  const adapter = await open();
  const sourceId = id();
  const targetId = id();
  const olderId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
  const newerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
  await adapter.createAgents([{ id: agentId, name: "Graph owner" }]);
  await adapter.createEntities([
    { id: sourceId, agentId, names: ["Source"] },
    { id: targetId, agentId, names: ["Target"] },
  ]);
  const storage = await adapter.getConnection();
  await storage.set("relationships", olderId, {
    id: olderId,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    agentId,
    tags: ["knows"],
    metadata: {},
    createdAt: "2026-08-20T16:00:00.000Z",
  });
  await storage.set("relationships", newerId, {
    id: newerId,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    agentId,
    tags: ["knows"],
    metadata: {},
    createdAt: "2026-08-20T23:00:00.000Z",
  });

  const first = await adapter.getRelationships({
    entityIds: [sourceId],
    limit: 1,
    offset: 0,
  });
  const second = await adapter.getRelationships({
    entityIds: [sourceId],
    limit: 1,
    offset: 1,
  });
  expect(first.map((relationship) => relationship.id)).toEqual([olderId]);
  expect(second.map((relationship) => relationship.id)).toEqual([newerId]);
});

it("returns messages from the requested world and treats limit 0 as empty", async () => {
  const adapter = await open();
  const worldId = id();
  const otherWorldId = id();
  const worldRoomId = id();
  const otherRoomId = id();
  const homeId = id();
  await adapter.createAgents([{ id: agentId, name: "World owner" }]);
  await adapter.createEntities([{ id: entityId, agentId, names: ["Owner"] }]);
  await adapter.createWorlds([
    { id: worldId, name: "Home", agentId },
    { id: otherWorldId, name: "Other", agentId },
  ]);
  await adapter.createRooms([
    {
      id: worldRoomId,
      agentId,
      worldId,
      type: ChannelType.DM,
      source: "test",
    },
    {
      id: otherRoomId,
      agentId,
      worldId: otherWorldId,
      type: ChannelType.DM,
      source: "test",
    },
  ]);
  await adapter.createMemories([
    {
      tableName: "messages",
      memory: {
        id: homeId,
        agentId,
        entityId,
        roomId: worldRoomId,
        content: { text: "home" },
      },
    },
    {
      tableName: "messages",
      memory: {
        id: id(),
        agentId,
        entityId,
        roomId: otherRoomId,
        content: { text: "away" },
      },
    },
    {
      tableName: "documents",
      memory: {
        id: id(),
        agentId,
        entityId,
        roomId: worldRoomId,
        content: { text: "doc" },
      },
    },
  ]);

  const found = await adapter.getMemoriesByWorldId({ worldId });
  expect(found.map((memory) => memory.id)).toEqual([homeId]);
  expect(await adapter.getMemoriesByWorldId({ worldIds: [worldId] })).toEqual(
    found,
  );
  expect(await adapter.getMemoriesByWorldId({ worldId, limit: 0 })).toEqual([]);
});

it("keeps entity name lookups inside the requested agent and honors an explicit empty page", async () => {
  const adapter = await open();
  const otherAgentId = id();
  const entities = Array.from({ length: 11 }, (_, index) => ({
    id: id(),
    agentId,
    names: [`Patron ${index}`],
  }));
  await adapter.createEntities(entities);
  const storage = await adapter.getConnection();
  await storage.set("entities", id(), {
    id: id(),
    agentId: otherAgentId,
    names: ["Patron 0"],
  });

  const named = await adapter.getEntitiesByNames({
    names: ["Patron 0"],
    agentId,
  });
  expect(named.map((entity) => entity.id)).toEqual([entities[0]?.id]);

  const all = await adapter.searchEntitiesByName({
    query: "patron",
    agentId,
  });
  expect(all).toHaveLength(11);
  expect(all.every((entity) => entity.agentId === agentId)).toBe(true);

  expect(
    await adapter.searchEntitiesByName({
      query: "patron",
      agentId,
      limit: 0,
    }),
  ).toEqual([]);
  expect(
    await adapter.searchEntitiesByName({
      query: "patron",
      agentId,
      limit: 1,
    }),
  ).toHaveLength(1);
});

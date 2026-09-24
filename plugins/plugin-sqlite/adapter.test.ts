/** Exercises actual SQLite files, adapter rollback, restart search and backup restore. */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelType,
  type Memory,
  MemoryType,
  ROLE_WRITE_AUDIT_LOG_TYPE,
  Role,
  readDocumentMutationSnapshot,
  type UUID,
  WORLD_METADATA_REVISION_KEY,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("restores document permissions and commits only one concurrent revision", async () => {
    const adapter = await open();
    const document = memory("private original");
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

/**
 * Exercises the SQL document pin mutation on real PGlite/Postgres storage:
 * CAS fencing, mutation authority, fail-closed visibility (an invisible
 * requester observes not_found for both current and stale snapshots — no
 * existence leak), and metadata-only persistence of the pin bit.
 */
import {
  ChannelType,
  type Entity,
  type Memory,
  MemoryType,
  type Room,
  readDocumentMutationSnapshot,
  type UUID,
  type World,
} from "@elizaos/core";
import { v4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { memoryTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const OWNER_ID = "40000000-0000-0000-0000-0000000000a1" as UUID;
const OUTSIDER_ID = "40000000-0000-0000-0000-0000000000a2" as UUID;
const MEMBER_ID = "40000000-0000-0000-0000-0000000000a3" as UUID;

describe("document pin mutation (real SQL)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let agentId: UUID;
  let roomId: UUID;
  let worldId: UUID;
  let ownerRoomIds: UUID[];

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("document_pin_mutation");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    agentId = setup.testAgentId;
    worldId = v4() as UUID;
    roomId = v4() as UUID;
    ownerRoomIds = [roomId];

    await adapter.createWorld({
      id: worldId,
      agentId,
      name: "Document pin world",
      serverId: "document-pin",
    } as World);
    await adapter.createRooms([
      {
        id: roomId,
        agentId,
        worldId,
        name: "documents",
        source: "test",
        type: ChannelType.DM,
      } as unknown as Room,
    ]);
    await adapter.createEntities([
      { id: OWNER_ID, agentId, names: ["Owner"] } as Entity,
      { id: OUTSIDER_ID, agentId, names: ["Outsider"] } as Entity,
      { id: MEMBER_ID, agentId, names: ["Member"] } as Entity,
    ]);
    await adapter.addParticipant(OWNER_ID, roomId);
    await adapter.addParticipant(MEMBER_ID, roomId);
  }, 120_000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    await db.delete(memoryTable);
  });

  function document(
    index: number,
    overrides: {
      scope?: string;
      entityId?: UUID;
    } = {}
  ): Memory {
    const id = `40000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}` as UUID;
    const entityId = overrides.entityId ?? OWNER_ID;
    return {
      id,
      agentId,
      entityId,
      roomId,
      worldId,
      createdAt: 10_000,
      content: { text: `Pin target body ${index}` },
      metadata: {
        type: MemoryType.DOCUMENT,
        documentId: id,
        documentRevision: 0,
        title: `Pin target ${index}`,
        scope: overrides.scope ?? "user-private",
        scopedToEntityId: entityId,
        addedBy: entityId,
        timestamp: 10_000,
      },
    } as Memory;
  }

  async function seed(documents: Memory[]): Promise<void> {
    await adapter.createMemories(documents.map((memory) => ({ memory, tableName: "documents" })));
  }

  it("pins and unpins through the CAS path, persisting metadata only", async () => {
    const doc = document(1);
    await seed([doc]);
    const expected = readDocumentMutationSnapshot(doc);
    if (!expected) throw new Error("snapshot must be valid");

    const pinned = await adapter.updateDocumentPinned({
      agentId,
      documentId: doc.id,
      requesterEntityId: OWNER_ID,
      requesterRoomIds: ownerRoomIds,
      requesterRole: "OWNER",
      expected,
      expectedPinned: false,
      pinned: true,
    });
    expect(pinned.status).toBe("updated");
    if (pinned.status !== "updated") throw new Error("expected updated");
    expect(pinned.document.metadata).toMatchObject({ pinned: true });

    const stored = await adapter.getDocument({
      agentId,
      documentId: doc.id,
      requesterEntityId: OWNER_ID,
      requesterRoomIds: ownerRoomIds,
      requesterRole: "OWNER",
    });
    const afterPin = readDocumentMutationSnapshot(stored as Memory);
    expect(afterPin).not.toBeNull();

    const unpinned = await adapter.updateDocumentPinned({
      agentId,
      documentId: doc.id,
      requesterEntityId: OWNER_ID,
      requesterRoomIds: ownerRoomIds,
      requesterRole: "OWNER",
      expected: afterPin as never,
      expectedPinned: true,
      pinned: false,
    });
    expect(unpinned.status).toBe("updated");
    if (unpinned.status !== "updated") throw new Error("expected updated");
    expect(unpinned.document.metadata).not.toMatchObject({ pinned: true });
  });

  it("fails closed for an invisible requester with both current and stale snapshots", async () => {
    // RP review round-1 must-fix: the pin SELECT must use the
    // visibility-aware read conditions so an unauthorized requester cannot
    // distinguish an existing document from an unknown id.
    const doc = document(2);
    await seed([doc]);
    const current = readDocumentMutationSnapshot(doc);
    if (!current) throw new Error("snapshot must be valid");
    const stale = { ...current, revision: current.revision + 99 };

    for (const expected of [current, stale]) {
      await expect(
        adapter.updateDocumentPinned({
          agentId,
          documentId: doc.id,
          requesterEntityId: OUTSIDER_ID,
          requesterRoomIds: [],
          requesterRole: "USER",
          expected: expected as never,
          expectedPinned: false,
          pinned: true,
        })
      ).resolves.toMatchObject({ status: "not_found" });
    }
  });

  it("rejects a visible non-mutator with forbidden after CAS passes", async () => {
    // A room member can see a global document but cannot mutate it.
    const doc = document(3, { scope: "global" });
    await seed([doc]);
    const current = readDocumentMutationSnapshot(doc);
    if (!current) throw new Error("snapshot must be valid");

    // Sanity: MEMBER can read the global document.
    const visible = await adapter.getDocument({
      agentId,
      documentId: doc.id,
      requesterEntityId: MEMBER_ID,
      requesterRoomIds: ownerRoomIds,
      requesterRole: "USER",
    });
    expect(visible?.id).toBe(doc.id);

    await expect(
      adapter.updateDocumentPinned({
        agentId,
        documentId: doc.id,
        requesterEntityId: MEMBER_ID,
        requesterRoomIds: ownerRoomIds,
        requesterRole: "USER",
        expected: current,
        expectedPinned: false,
        pinned: true,
      })
    ).resolves.toMatchObject({ status: "forbidden" });
  });

  it("conflicts on a stale snapshot for the owner", async () => {
    const doc = document(4);
    await seed([doc]);
    const current = readDocumentMutationSnapshot(doc);
    if (!current) throw new Error("snapshot must be valid");
    const stale = { ...current, revision: current.revision + 99 };

    await expect(
      adapter.updateDocumentPinned({
        agentId,
        documentId: doc.id,
        requesterEntityId: OWNER_ID,
        requesterRoomIds: ownerRoomIds,
        requesterRole: "OWNER",
        expected: stale as never,
        expectedPinned: false,
        pinned: true,
      })
    ).resolves.toMatchObject({ status: "conflict" });
  });

  it("two racing pin writers from the same observed state: exactly one wins, loser conflicts and retry converges", async () => {
    // Reviewer-requested REAL two-writer proof (#23103): both writers read
    // the document BEFORE either writes (same authorization snapshot AND
    // same observed pin bit), then race their CAS writes on one real SQL
    // engine. The expectedPinned fence must serialize them: exactly one
    // `updated`, the other `conflict` — never two `updated` (lost update).
    // The loser then re-reads fresh state and its retry converges.
    const doc = document(6);
    await seed([doc]);
    const observed = await adapter.getDocument({
      agentId,
      documentId: doc.id,
      requesterEntityId: OWNER_ID,
      requesterRoomIds: ownerRoomIds,
      requesterRole: "OWNER",
    });
    expect(observed).not.toBeNull();
    const snapshot = readDocumentMutationSnapshot(observed as Memory);
    if (!snapshot) throw new Error("snapshot must be valid");

    const pinParams = () => ({
      agentId,
      documentId: doc.id,
      requesterEntityId: OWNER_ID,
      requesterRoomIds: ownerRoomIds,
      requesterRole: "OWNER",
      expected: snapshot,
      expectedPinned: false,
      pinned: true,
    });
    const [first, second] = await Promise.all([
      adapter.updateDocumentPinned(pinParams()),
      adapter.updateDocumentPinned(pinParams()),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["conflict", "updated"]);

    // The losing writer retries against freshly read state and converges.
    const fresh = await adapter.getDocument({
      agentId,
      documentId: doc.id,
      requesterEntityId: OWNER_ID,
      requesterRoomIds: ownerRoomIds,
      requesterRole: "OWNER",
    });
    const freshSnapshot = readDocumentMutationSnapshot(fresh as Memory);
    if (!freshSnapshot) throw new Error("fresh snapshot must be valid");
    const retried = await adapter.updateDocumentPinned({
      agentId,
      documentId: doc.id,
      requesterEntityId: OWNER_ID,
      requesterRoomIds: ownerRoomIds,
      requesterRole: "OWNER",
      expected: freshSnapshot,
      expectedPinned: true,
      pinned: false,
    });
    expect(retried.status).toBe("updated");
    expect(retried.document.metadata).not.toMatchObject({ pinned: true });
  });

  it("returns not_found for an unknown document id", async () => {
    await expect(
      adapter.updateDocumentPinned({
        agentId,
        documentId: "40000000-0000-0000-0000-00000000dead" as UUID,
        requesterEntityId: OWNER_ID,
        requesterRoomIds: ownerRoomIds,
        requesterRole: "OWNER",
        expected: {
          scope: "user-private",
          roomId,
          entityId: OWNER_ID,
          revision: 0,
        } as never,
        expectedPinned: false,
        pinned: true,
      })
    ).resolves.toMatchObject({ status: "not_found" });
  });
});

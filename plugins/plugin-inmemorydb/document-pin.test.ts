/**
 * Exercises the atomic document pin toggle against the first-party ephemeral
 * adapter: CAS fencing, mutation authority, visibility fail-closed, and the
 * metadata-only pin write inside the adapter's mutation lock. No mocks.
 */
import { type Memory, MemoryType, readDocumentMutationSnapshot, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_ID = "51000000-0000-0000-0000-000000000001" as UUID;
const OWNER_ID = "51000000-0000-0000-0000-000000000002" as UUID;
const OUTSIDER_ID = "51000000-0000-0000-0000-000000000003" as UUID;
const ROOM_A = "51000000-0000-0000-0000-000000000004" as UUID;

function document(index: number): Memory & { id: UUID } {
  const id = `51000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}` as UUID;
  return {
    id,
    agentId: AGENT_ID,
    entityId: OWNER_ID,
    roomId: ROOM_A,
    createdAt: 1_000,
    content: { text: `Document ${index}` },
    metadata: {
      type: MemoryType.DOCUMENT,
      documentId: id,
      documentRevision: 0,
      timestamp: 1_000,
      scope: "user-private",
      scopedToEntityId: OWNER_ID,
      addedBy: OWNER_ID,
    },
  };
}

async function makeAdapter() {
  const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
  await adapter.initialize();
  await adapter.createRoomParticipants([AGENT_ID, OWNER_ID, OUTSIDER_ID], ROOM_A);
  return adapter;
}

describe("InMemoryDatabaseAdapter.updateDocumentPinned", () => {
  it("pins and unpins the document metadata atomically", async () => {
    const adapter = await makeAdapter();
    const doc = document(1);
    await adapter.createMemories([{ memory: doc, tableName: "documents" }]);
    const expected = readDocumentMutationSnapshot(doc);
    if (!expected) throw new Error("snapshot must be valid");

    await expect(
      adapter.updateDocumentPinned({
        agentId: AGENT_ID,
        documentId: doc.id,
        requesterEntityId: OWNER_ID,
        requesterRoomIds: [ROOM_A],
        requesterRole: "USER",
        expected,
        expectedPinned: false,
        pinned: true,
      })
    ).resolves.toMatchObject({
      status: "updated",
      document: { metadata: { pinned: true } },
    });

    const afterPin = await adapter.getDocument({
      agentId: AGENT_ID,
      documentId: doc.id,
      requesterEntityId: OWNER_ID,
      requesterRoomIds: [ROOM_A],
      requesterRole: "USER",
    });
    const snapshotAfterPin = readDocumentMutationSnapshot(afterPin as Memory);
    expect(snapshotAfterPin).not.toBeNull();

    await expect(
      adapter.updateDocumentPinned({
        agentId: AGENT_ID,
        documentId: doc.id,
        requesterEntityId: OWNER_ID,
        requesterRoomIds: [ROOM_A],
        requesterRole: "USER",
        expected: snapshotAfterPin as never,
        expectedPinned: true,
        pinned: false,
      })
    ).resolves.toMatchObject({ status: "updated" });

    const afterUnpin = await adapter.getDocument({
      agentId: AGENT_ID,
      documentId: doc.id,
      requesterEntityId: OWNER_ID,
      requesterRoomIds: [ROOM_A],
      requesterRole: "USER",
    });
    const unpinnedMetadata = afterUnpin?.metadata as Record<string, unknown>;
    expect(unpinnedMetadata.pinned).toBeUndefined();
  });

  it("rejects a stale snapshot with conflict after an authorization change", async () => {
    const adapter = await makeAdapter();
    const granteeId = "51000000-0000-0000-0000-000000000099" as UUID;
    await adapter.createEntities([
      { id: granteeId, agentId: AGENT_ID, names: ["Grantee"] } as never,
    ]);
    const doc = document(2);
    await adapter.createMemories([{ memory: doc, tableName: "documents" }]);
    const stale = readDocumentMutationSnapshot(doc);
    if (!stale) throw new Error("snapshot must be valid");

    // Change a snapshotted authorization field (direct grants) after the
    // snapshot was taken — the pin CAS write must observe the mismatch.
    const grants = await adapter.updateDocumentDirectGrants({
      agentId: AGENT_ID,
      documentId: doc.id,
      requesterEntityId: OWNER_ID,
      requesterRoomIds: [ROOM_A],
      requesterRole: "OWNER",
      expected: stale,
      directGrantEntityIds: [granteeId],
    });
    expect(grants.status).toBe("updated");

    await expect(
      adapter.updateDocumentPinned({
        agentId: AGENT_ID,
        documentId: doc.id,
        requesterEntityId: OWNER_ID,
        requesterRoomIds: [ROOM_A],
        requesterRole: "USER",
        expected: stale,
        expectedPinned: false,
        pinned: true,
      })
    ).resolves.toMatchObject({ status: "conflict" });
  });

  it("fails closed for a requester who cannot see the document", async () => {
    const adapter = await makeAdapter();
    const doc = document(3);
    await adapter.createMemories([{ memory: doc, tableName: "documents" }]);
    const expected = readDocumentMutationSnapshot(doc);
    if (!expected) throw new Error("snapshot must be valid");

    await expect(
      adapter.updateDocumentPinned({
        agentId: AGENT_ID,
        documentId: doc.id,
        requesterEntityId: OUTSIDER_ID,
        requesterRoomIds: [],
        requesterRole: "GUEST",
        expected,
        expectedPinned: false,
        pinned: true,
      })
    ).resolves.toMatchObject({ status: "not_found" });
  });

  it("returns not_found for an unknown document id", async () => {
    const adapter = await makeAdapter();
    await expect(
      adapter.updateDocumentPinned({
        agentId: AGENT_ID,
        documentId: "51000000-0000-0000-0000-00000000dead" as UUID,
        requesterEntityId: OWNER_ID,
        requesterRoomIds: [ROOM_A],
        requesterRole: "USER",
        expected: {
          scope: "user-private",
          roomId: ROOM_A,
          entityId: OWNER_ID,
          revision: 0,
        } as never,
        expectedPinned: false,
        pinned: true,
      })
    ).resolves.toMatchObject({ status: "not_found" });
  });

  it("hides document existence from an invisible requester even with a stale snapshot", async () => {
    // RP review round-1 must-fix: CAS-before-visibility ordering let an
    // invisible requester distinguish an existing document (conflict) from an
    // unknown id (not_found). Visibility must fail closed FIRST.
    const adapter = await makeAdapter();
    const doc = document(4);
    await adapter.createMemories([{ memory: doc, tableName: "documents" }]);
    const current = readDocumentMutationSnapshot(doc);
    if (!current) throw new Error("snapshot must be valid");
    const stale = { ...current, revision: current.revision + 99 };

    for (const expected of [current, stale]) {
      await expect(
        adapter.updateDocumentPinned({
          agentId: AGENT_ID,
          documentId: doc.id,
          requesterEntityId: OUTSIDER_ID,
          requesterRoomIds: [],
          requesterRole: "GUEST",
          expected,
          expectedPinned: false,
          pinned: true,
        })
      ).resolves.toMatchObject({ status: "not_found" });
    }
  });

  it("hides existence from a visible-but-non-mutating requester on CAS mismatch", async () => {
    // A room member who can see a global document but cannot mutate it must
    // observe the CAS result (conflict), not forbidden-before-CAS — matching
    // the sibling CAS mutation methods' observable contract.
    const adapter = await makeAdapter();
    const base = document(5);
    const globalDoc: Memory = {
      ...base,
      metadata: {
        ...base.metadata,
        scope: "global",
      },
    };
    await adapter.createMemories([{ memory: globalDoc, tableName: "documents" }]);
    const current = readDocumentMutationSnapshot(globalDoc);
    if (!current) throw new Error("snapshot must be valid");
    const stale = { ...current, revision: current.revision + 99 };

    // Sanity: the OUTSIDER (room member) can see the global document.
    const visible = await adapter.getDocument({
      agentId: AGENT_ID,
      documentId: globalDoc.id,
      requesterEntityId: OUTSIDER_ID,
      requesterRoomIds: [ROOM_A],
      requesterRole: "GUEST",
    });
    expect(visible?.id).toBe(globalDoc.id);

    // Stale snapshot → conflict (existence already visible to this requester).
    await expect(
      adapter.updateDocumentPinned({
        agentId: AGENT_ID,
        documentId: globalDoc.id,
        requesterEntityId: OUTSIDER_ID,
        requesterRoomIds: [ROOM_A],
        requesterRole: "GUEST",
        expected: stale,
        expectedPinned: false,
        pinned: true,
      })
    ).resolves.toMatchObject({ status: "conflict" });

    // Current snapshot → forbidden (mutation policy), never a write.
    await expect(
      adapter.updateDocumentPinned({
        agentId: AGENT_ID,
        documentId: globalDoc.id,
        requesterEntityId: OUTSIDER_ID,
        requesterRoomIds: [ROOM_A],
        requesterRole: "GUEST",
        expected: current,
        expectedPinned: false,
        pinned: true,
      })
    ).resolves.toMatchObject({ status: "forbidden" });
  });
});

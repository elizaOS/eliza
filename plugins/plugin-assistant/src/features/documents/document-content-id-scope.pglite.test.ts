/**
 * Content-based document ids must not let one user's upload resolve to
 * another user's (or another visibility's) stored document: identical private
 * uploads from different users are stored separately, and an owner's global
 * upload is published globally even when a user already holds the same file
 * privately. Real AgentRuntime storage, no model calls.
 */
import type { AgentRuntime } from "@elizaos/core";
import {
  ChannelType,
  type Memory,
  setEntityRoleCas,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentService } from "./service";

const ALICE = "f5300000-0000-4000-8000-000000000001" as UUID;
const BOB = "f5300000-0000-4000-8000-000000000002" as UUID;
const WORLD_ID = "f5300000-0000-4000-8000-000000000003" as UUID;
const ROOM_A = "f5300000-0000-4000-8000-000000000004" as UUID;
const ROOM_B = "f5300000-0000-4000-8000-000000000005" as UUID;

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let service: DocumentService;

beforeAll(async () => {
  const created = await createTestRuntime({ characterName: "DedupRepro" });
  runtime = created.runtime;
  cleanup = created.cleanup;
  for (const [entityId, roomId] of [
    [ALICE, ROOM_A],
    [BOB, ROOM_B],
  ] as const) {
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId: WORLD_ID,
      worldName: "w",
      userName: entityId,
      name: entityId,
      source: "test",
      type: ChannelType.DM,
    });
  }
  const msg: Memory = {
    id: "f5300000-0000-4000-8000-000000000009" as UUID,
    agentId: runtime.agentId,
    entityId: ALICE,
    roomId: ROOM_A,
    worldId: WORLD_ID,
    content: { text: "x", source: "test", channelType: ChannelType.DM },
  };
  for (const id of [ALICE, BOB]) {
    const g = await setEntityRoleCas(runtime, msg, id, "USER", {
      worldId: WORLD_ID,
      source: "manual",
    });
    expect(g.status).toBe("committed");
  }
  service = new DocumentService(runtime);
}, 120_000);

afterAll(async () => {
  await cleanup?.();
}, 120_000);

function upload(entityId: UUID, roomId: UUID) {
  return service.addDocument({
    agentId: runtime.agentId,
    worldId: WORLD_ID,
    roomId,
    entityId,
    clientDocumentId: "" as UUID,
    contentType: "text/plain",
    originalFilename: "resume.txt",
    content: "Quarterly plan: ship the thing by Friday.",
    scope: "user-private",
    scopedToEntityId: entityId,
    addedBy: entityId,
    addedByRole: "USER",
    addedFrom: "upload",
    metadata: {
      scope: "user-private",
      scopedToEntityId: entityId,
      filename: "resume.txt",
    },
  });
}

describe("cross-user dedup of user-private uploads", () => {
  it("bob's private upload of identical content is stored for bob", async () => {
    const a = await upload(ALICE, ROOM_A);
    const b = await upload(BOB, ROOM_B);
    const bobCtx = {
      requesterEntityId: BOB,
      role: "USER" as const,
      isOwner: false,
    };
    const bobView = await service
      .getDocumentByIdWithAccessContext(b.storedDocumentMemoryId, bobCtx)
      .catch((e) => `ERR ${e?.code ?? e?.message}`);

    expect(b.storedDocumentMemoryId).not.toBe(a.storedDocumentMemoryId);
    expect(bobView).toBeTruthy();
    expect(typeof bobView).toBe("object");
  });
});

describe("owner global upload after a user-private upload of the same file", () => {
  it("owner's global upload is published globally", async () => {
    const content = "Company handbook v3: PTO policy is 25 days.";
    const base = {
      agentId: runtime.agentId,
      worldId: WORLD_ID,
      clientDocumentId: "" as UUID,
      contentType: "text/plain",
      originalFilename: "handbook.txt",
      content,
      addedFrom: "upload" as const,
    };
    await service.addDocument({
      ...base,
      roomId: ROOM_A,
      entityId: ALICE,
      scope: "user-private",
      scopedToEntityId: ALICE,
      addedBy: ALICE,
      addedByRole: "USER",
      metadata: {
        scope: "user-private",
        scopedToEntityId: ALICE,
        filename: "handbook.txt",
      },
    });
    const o = await service.addDocument({
      ...base,
      roomId: ROOM_B,
      entityId: runtime.agentId,
      scope: "global",
      addedBy: runtime.agentId,
      addedByRole: "OWNER",
      metadata: { scope: "global", filename: "handbook.txt" },
    });
    const stored = await runtime.getMemoryById(o.storedDocumentMemoryId);
    expect((stored?.metadata as { scope?: string } | undefined)?.scope).toBe(
      "global",
    );
  });
});

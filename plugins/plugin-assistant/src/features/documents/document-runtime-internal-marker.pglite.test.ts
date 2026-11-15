import { randomUUID } from "node:crypto";
import { ChannelType, type UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { DocumentService } from "./service.ts";

it("an uploaded document cannot mark itself runtime-internal to hide from the owner", async () => {
  const owner = randomUUID() as UUID;
  const roomId = randomUUID() as UUID;
  const worldId = randomUUID() as UUID;
  const fixture = await createTestRuntime({
    characterName: "RuntimeInternalMarker",
    settings: { ELIZA_ADMIN_ENTITY_ID: owner },
  });
  try {
    const { runtime } = fixture;
    await runtime.ensureConnection({
      entityId: owner,
      roomId,
      worldId,
      worldName: "Synthetic marker",
      userName: "Owner",
      name: "Marker",
      source: "test",
      type: ChannelType.DM,
    });
    const service = new DocumentService(runtime);
    const stored = await service.addDocument({
      agentId: runtime.agentId,
      entityId: owner,
      addedBy: owner,
      roomId,
      worldId,
      clientDocumentId: "" as UUID,
      originalFilename: "hidden.txt",
      contentType: "text/plain",
      content: "Synthetic upload that asks to be runtime-internal.",
      scope: "owner-private",
      metadata: { runtimeInternal: true },
    });
    const listed = await service.listAllDocumentsWithAccessContext({
      requesterEntityId: owner,
      role: "OWNER",
      isOwner: true,
    });
    expect(listed.map((document) => document.id)).toContain(
      stored.storedDocumentMemoryId,
    );
  } finally {
    await fixture.cleanup();
  }
}, 120_000);

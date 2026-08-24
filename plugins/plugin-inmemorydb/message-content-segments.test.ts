/**
 * Exercises atomic message/attachment segment publication and bounded reads
 * through the public ephemeral adapter with real storage and authorization.
 */
import {
  buildMessageContentProjection,
  collectMessageContentSegmentIds,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_ID = "71000000-0000-4000-8000-000000000001" as UUID;
const ENTITY_ID = "71000000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "71000000-0000-4000-8000-000000000003" as UUID;
const MESSAGE_ID = "71000000-0000-4000-8000-000000000004" as UUID;

function message(text: string): Memory & { id: UUID } {
  return {
    id: MESSAGE_ID,
    agentId: AGENT_ID,
    entityId: ENTITY_ID,
    roomId: ROOM_ID,
    createdAt: 1_700_000_000_000,
    content: { text },
    metadata: { type: "message", scope: "room" },
  };
}

describe("InMemoryDatabaseAdapter message content segments", () => {
  it("publishes atomically, reads bounded pages, and rejects stale continuation", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    await adapter.createRoomParticipants([ENTITY_ID], ROOM_ID);

    const original = message("first revision 🙂\n".repeat(20_000));
    const firstProjection = buildMessageContentProjection(original);
    await expect(
      adapter.publishMessageContentSegments({
        mode: "create",
        parent: { ...original, content: firstProjection.content },
        segments: firstProjection.segments,
      })
    ).resolves.toMatchObject({ status: "created" });

    const first = await adapter.readMessageContentRange({
      agentId: AGENT_ID,
      messageId: MESSAGE_ID,
      authorizedRoomId: ROOM_ID,
      accessContext: { requesterEntityId: ENTITY_ID, role: "USER" },
      source: { kind: "message-text" },
      offset: 0,
      limit: 32 * 1024,
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("expected segmented page");
    expect(first.page.returnedBytes).toBeGreaterThan(0);
    expect(first.page.returnedSegments).toBeLessThanOrEqual(3);
    expect(first.page.sourceQueryCount).toBe(0);

    const replacement = message("second revision 漢字\n".repeat(20_000));
    const secondProjection = buildMessageContentProjection(replacement);
    await expect(
      adapter.publishMessageContentSegments({
        mode: "replace",
        agentId: AGENT_ID,
        messageId: MESSAGE_ID,
        expectedContent: firstProjection.content,
        replacementContent: secondProjection.content,
        segments: secondProjection.segments,
        removeSegmentIds: collectMessageContentSegmentIds(MESSAGE_ID, firstProjection.content),
      })
    ).resolves.toMatchObject({ status: "updated" });

    await expect(
      adapter.readMessageContentRange({
        agentId: AGENT_ID,
        messageId: MESSAGE_ID,
        authorizedRoomId: ROOM_ID,
        accessContext: { requesterEntityId: ENTITY_ID, role: "USER" },
        source: { kind: "message-text" },
        offset: first.page.end,
        limit: 32 * 1024,
        expectedRevision: first.page.revision,
      })
    ).rejects.toMatchObject({ code: "MESSAGE_CONTENT_STALE_REVISION" });
  });

  it("reauthorizes every read against current room participation", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    await adapter.createRoomParticipants([ENTITY_ID], ROOM_ID);
    const original = message("private room content 🙂\n".repeat(8_000));
    const projection = buildMessageContentProjection(original);
    await adapter.publishMessageContentSegments({
      mode: "create",
      parent: { ...original, content: projection.content },
      segments: projection.segments,
    });

    await adapter.deleteParticipants([{ entityId: ENTITY_ID, roomId: ROOM_ID }]);
    await expect(
      adapter.readMessageContentRange({
        agentId: AGENT_ID,
        messageId: MESSAGE_ID,
        authorizedRoomId: ROOM_ID,
        accessContext: { requesterEntityId: ENTITY_ID, role: "USER" },
        source: { kind: "message-text" },
        offset: 0,
        limit: 1024,
      })
    ).resolves.toEqual({ status: "forbidden" });
  });
});

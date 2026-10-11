/** Encrypted agent transfer keeps a message whose text exceeds the inline limit readable and editable through the real SQL segment APIs of the imported agent. */
import {
  buildMessageContentProjection,
  ChannelType,
  collectMessageContentSegmentIds,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { exportAgent, importAgent } from "../src/services/agent-export.ts";

const MARKER = "transfer-segment-marker";

it("reads and replaces an imported message stored in content segments", async () => {
  const fixture = await createTestRuntime({
    characterName: "TransferMessageSegments",
  });
  try {
    const runtime = fixture.runtime;
    const entityId = crypto.randomUUID() as UUID;
    const roomId = crypto.randomUUID() as UUID;
    const worldId = crypto.randomUUID() as UUID;
    await runtime.createWorld({
      id: worldId,
      agentId: runtime.agentId,
      name: "Segment world",
    });
    await runtime.createEntity({
      id: entityId,
      agentId: runtime.agentId,
      names: ["Segment reader"],
    });
    await runtime.createRoom({
      id: roomId,
      agentId: runtime.agentId,
      source: "test",
      type: ChannelType.GROUP,
      name: "Segment room",
      worldId,
    });
    await runtime.addParticipant(entityId, roomId);
    const text = `${MARKER}\n${"large transferred message body\n".repeat(4_000)}`;
    const sourceMessageId = await runtime.createMessageMemory({
      id: crypto.randomUUID() as UUID,
      agentId: runtime.agentId,
      entityId,
      roomId,
      content: { text },
      metadata: { type: "message", scope: "room" },
    } as Memory);

    const password = "message-segment-transfer-password";
    const bundle = await exportAgent(runtime, password);
    const imported = await importAgent(runtime, bundle, password);
    expect(imported.success).toBe(true);
    const newAgentId = imported.agentId as UUID;
    if (!runtime.adapter.withAgentScope) throw Error("Missing scoped adapter");

    await runtime.adapter.withAgentScope(newAgentId, async (db) => {
      const [message] = await db.getMemories({
        agentId: newAgentId,
        tableName: "messages",
      });
      if (!message?.id || !message.roomId || !message.entityId) {
        throw Error("Imported message is missing");
      }
      expect(message.id).not.toBe(sourceMessageId);
      expect(message.content.text).toBeUndefined();

      const page = await db.readMessageContentRange?.({
        agentId: newAgentId,
        messageId: message.id,
        authorizedRoomId: message.roomId,
        accessContext: { requesterEntityId: message.entityId, role: "USER" },
        source: { kind: "message-text" },
        offset: 0,
        limit: 32,
      });
      expect(page).toMatchObject({
        status: "ok",
        page: { text: `${MARKER}\nlarge tr`, start: 0, end: 32 },
      });

      const replacement = buildMessageContentProjection({
        ...message,
        id: message.id,
        content: { text: "edited after transfer" },
      });
      await expect(
        db.publishMessageContentSegments?.({
          mode: "replace",
          agentId: newAgentId,
          messageId: message.id,
          expectedContent: message.content,
          replacementContent: replacement.content,
          segments: replacement.segments,
          removeSegmentIds: collectMessageContentSegmentIds(
            message.id,
            message.content,
          ),
        }),
      ).resolves.toMatchObject({
        status: "updated",
        parent: { content: { text: "edited after transfer" } },
      });
    });
  } finally {
    await fixture.cleanup();
  }
}, 180_000);

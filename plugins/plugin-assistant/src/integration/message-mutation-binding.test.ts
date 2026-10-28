import {
  ChannelType,
  type Memory,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../../../plugin-sql/src/__tests__/test-helpers";
import { messageAction } from "../features/advanced-capabilities/actions/message";

it("binds stored message mutations to their room and preserves native UUID ids", async () => {
  const f = await createIsolatedTestDatabase("message-mutation-binding");
  const worldId = "33333333-3333-4333-8333-333333333333" as UUID;
  const roomId = "44444444-4444-4444-8444-444444444444" as UUID;
  const otherRoomId = "66666666-6666-4666-8666-666666666666" as UUID;
  const userId = "55555555-5555-4555-8555-555555555555" as UUID;
  const memoryId = "88888888-8888-4888-8888-888888888888" as UUID;
  const nativeId = "99999999-9999-4999-8999-999999999999";
  const calls: Array<{ target: TargetInfo; messageId: string }> = [];
  try {
    await f.runtime.createEntity({
      id: userId,
      names: ["Owner"],
      agentId: f.testAgentId,
    });
    await f.runtime.ensureWorldExists({
      id: worldId,
      name: "Slack",
      agentId: f.testAgentId,
    });
    await f.runtime.ensureRoomExists({
      worldId,
      id: roomId,
      source: "slack",
      type: ChannelType.GROUP,
      channelId: "C_ORIGINAL",
      metadata: { accountId: "work" },
    });
    await f.runtime.ensureParticipantInRoom(userId, roomId);
    const record = async (
      _runtime: unknown,
      payload: { target: TargetInfo; messageId: string },
    ) => {
      calls.push(payload);
    };
    f.runtime.registerMessageConnector({
      source: "slack",
      accountId: "work",
      label: "Slack",
      capabilities: [],
      supportedTargetKinds: ["room", "channel"],
      contexts: ["social"],
      reactHandler: record,
      editHandler: record,
      deleteHandler: record,
      pinHandler: record,
    });
    const message: Memory = {
      id: "77777777-7777-4777-8777-777777777777" as UUID,
      agentId: f.testAgentId,
      entityId: userId,
      roomId,
      content: { text: "change this message", source: "slack" },
      metadata: { type: "message", source: "slack", accountId: "work" },
    };
    await f.runtime.createMemory(
      {
        id: memoryId,
        agentId: f.testAgentId,
        entityId: userId,
        roomId,
        content: { text: "original", source: "slack" },
        metadata: {
          type: "message",
          source: "slack",
          accountId: "work",
          platformMessageId: "123.456",
        },
      },
      "messages",
    );
    const invoke = (
      op: string,
      id: string,
      extra: Record<string, unknown> = {},
    ) =>
      messageAction.handler(f.runtime, message, undefined, {
        parameters: {
          op,
          messageId: id,
          emoji: "👍",
          text: "edited",
          ...extra,
        },
      });
    for (const op of ["react", "edit", "delete", "pin"]) {
      expect(await invoke(op, memoryId)).toMatchObject({ success: true });
      expect(calls.at(-1)).toMatchObject({
        messageId: "123.456",
        target: { source: "slack", accountId: "work", roomId },
      });
      expect(await invoke(op, nativeId)).toMatchObject({ success: true });
      expect(calls.at(-1)).toMatchObject({
        messageId: nativeId,
        target: { roomId },
      });
    }
    const count = calls.length;
    for (const extra of [
      { roomId: otherRoomId },
      { channelId: "C_OTHER" },
      { source: "discord" },
      { accountId: "personal" },
      { entityId: userId },
    ]) {
      expect(await invoke("delete", memoryId, extra)).toMatchObject({
        success: false,
      });
    }
    expect(calls).toHaveLength(count);
    await f.runtime.removeParticipant(userId, roomId);
    expect(await invoke("delete", memoryId)).toMatchObject({ success: false });
    expect(calls).toHaveLength(count);
  } finally {
    await f.cleanup();
  }
});

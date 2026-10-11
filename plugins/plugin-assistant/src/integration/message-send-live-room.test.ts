/** Proves MESSAGE op=send keeps the connector-owned room it delivered into intact. */
import {
  ChannelType,
  type Content,
  type Memory,
  stringToUuid,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../../../plugin-sql/src/__tests__/test-helpers";
import { messageAction } from "../features/advanced-capabilities/actions/message";

it("sending into an existing Slack room keeps its world, type, and routing metadata", async () => {
  const f = await createIsolatedTestDatabase("message-send-live-room");
  const worldId = "33333333-3333-4333-8333-333333333333" as UUID;
  const roomId = "44444444-4444-4444-8444-444444444444" as UUID;
  const userId = "55555555-5555-4555-8555-555555555555" as UUID;
  const deliveries: Array<{ channelId?: string; threadTs?: unknown }> = [];
  try {
    f.runtime.setSetting("OUTBOUND_VOICE_REWRITE", "false");
    await f.runtime.createEntity({
      id: f.testAgentId,
      names: ["Agent"],
      agentId: f.testAgentId,
    });
    await f.runtime.ensureWorldExists({
      id: worldId,
      name: "Acme Slack",
      agentId: f.testAgentId,
      metadata: { teamId: "T0ACME" },
    });
    await f.runtime.ensureRoomExists({
      id: roomId,
      name: "launch thread",
      source: "slack",
      type: ChannelType.THREAD,
      channelId: "C0LAUNCH",
      worldId,
      metadata: { accountId: "work", threadTs: "1712345678.000100" },
    });
    f.runtime.registerMessageConnector({
      source: "slack",
      label: "Slack",
      capabilities: ["send_message"],
      supportedTargetKinds: ["room", "channel", "thread"],
      contexts: ["social"],
      sendHandler: async (runtime, target: TargetInfo, content: Content) => {
        const room = target.roomId
          ? await runtime.getRoom(target.roomId)
          : null;
        deliveries.push({
          channelId: room?.channelId,
          threadTs: room?.metadata?.threadTs,
        });
        const platformMessageId = `1712345678.00020${deliveries.length}`;
        return {
          id: stringToUuid(`slack:${platformMessageId}`),
          entityId: f.testAgentId,
          agentId: f.testAgentId,
          roomId,
          content: { ...content, source: "slack" },
          metadata: { type: "message", platformMessageId },
        } as Memory;
      },
    });

    const message: Memory = {
      id: "77777777-7777-4777-8777-777777777777" as UUID,
      agentId: f.testAgentId,
      entityId: userId,
      roomId,
      content: { text: "post the launch note here", source: "slack" },
    };
    const send = (text: string) =>
      messageAction.handler(f.runtime, message, undefined, {
        parameters: {
          op: "send",
          source: "slack",
          target: roomId,
          targetKind: "room",
          message: text,
        },
      });

    expect(await send("Launch is at 3pm.")).toMatchObject({ success: true });
    expect(await send("Moved to 4pm.")).toMatchObject({ success: true });
    expect(deliveries).toEqual([
      { channelId: "C0LAUNCH", threadTs: "1712345678.000100" },
      { channelId: "C0LAUNCH", threadTs: "1712345678.000100" },
    ]);
    const room = await f.runtime.getRoom(roomId);
    expect(room).toMatchObject({
      id: roomId,
      name: "launch thread",
      source: "slack",
      type: ChannelType.THREAD,
      channelId: "C0LAUNCH",
      worldId,
      metadata: { accountId: "work", threadTs: "1712345678.000100" },
    });
  } finally {
    await f.cleanup();
  }
});

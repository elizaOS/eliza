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

it("reading recent messages reports connectors that could not be read", async () => {
  const f = await createIsolatedTestDatabase("message-read-channel-failures");
  const userId = "55555555-5555-4555-8555-555555555555" as UUID;
  const roomId = "66666666-6666-4666-8666-666666666666" as UUID;
  let slackWorks = false;
  try {
    const register = (source: string, label: string, fails: () => boolean) =>
      f.runtime.registerMessageConnector({
        source,
        label,
        capabilities: ["send_message", "read_messages"],
        supportedTargetKinds: ["channel"],
        contexts: ["social"],
        sendHandler: async () => undefined,
        listRecentTargets: async () => {
          if (fails()) throw new Error(`${label} token was revoked`);
          return [{ target: { source, channelId: "C1" } }];
        },
        fetchMessages: async () => [
          {
            id: stringToUuid(`${source}:m1`),
            entityId: userId,
            agentId: f.testAgentId,
            roomId,
            content: { text: `hello from ${label}`, source },
            createdAt: 1_760_000_000_000,
          } as Memory,
        ],
      });
    register("discord", "Discord", () => true);
    register("slack", "Slack", () => !slackWorks);

    const message: Memory = {
      id: "88888888-8888-4888-8888-888888888888" as UUID,
      agentId: f.testAgentId,
      entityId: userId,
      roomId,
      content: { text: "what are my recent messages", source: "client_chat" },
    };
    const read = () =>
      messageAction.handler(f.runtime, message, undefined, {
        parameters: { action: "read_channel" },
      });

    // Every connector failed: a failure, not "No recent conversations found."
    const allFailed = await read();
    expect(allFailed).toMatchObject({
      success: false,
      values: { error: "MESSAGE_READ_CHANNEL_FAILED" },
    });
    expect(allFailed?.text).toContain("Discord token was revoked");
    expect(allFailed?.text).toContain("Slack token was revoked");

    // One connector failed: the messages are returned and the failure named.
    slackWorks = true;
    const partial = await read();
    expect(partial).toMatchObject({ success: true });
    expect(partial?.text).toContain("Could not read: discord");
    expect(partial?.data).toMatchObject({
      sources: [{ source: "slack", count: 1 }],
      failedSources: [{ source: "discord" }],
    });
  } finally {
    await f.cleanup();
  }
});

it("an inferred-source send skips a connector whose discovery hooks fail", async () => {
  const f = await createIsolatedTestDatabase("message-send-failed-discovery");
  const userId = "55555555-5555-4555-8555-555555555555" as UUID;
  const roomId = "99999999-9999-4999-8999-999999999999" as UUID;
  const worldId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
  const deliveries: Array<{ source: string; channelId?: string }> = [];
  let slackDiscoveryFails = false;
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
    });
    await f.runtime.ensureRoomExists({
      id: roomId,
      name: "eng-standup",
      source: "slack",
      type: ChannelType.GROUP,
      channelId: "C0STANDUP",
      worldId,
    });
    const unavailable = (): never => {
      throw Object.assign(
        new Error("Discord account client is not initialized"),
        { code: "DISCORD_ACCOUNT_NOT_INITIALIZED" },
      );
    };
    f.runtime.registerMessageConnector({
      source: "discord",
      label: "Discord",
      capabilities: ["send_message"],
      supportedTargetKinds: ["channel"],
      contexts: ["social"],
      sendHandler: async (_runtime, target: TargetInfo) => {
        deliveries.push({ source: "discord", channelId: target.channelId });
        return undefined;
      },
      resolveTargets: async () => unavailable(),
      listRecentTargets: async () => unavailable(),
      listRooms: async () => unavailable(),
    });
    f.runtime.registerMessageConnector({
      source: "slack",
      label: "Slack",
      capabilities: ["send_message"],
      supportedTargetKinds: ["channel"],
      contexts: ["social"],
      sendHandler: async (_runtime, target: TargetInfo, content: Content) => {
        deliveries.push({ source: "slack", channelId: target.channelId });
        return {
          id: stringToUuid("slack:standup-1"),
          entityId: f.testAgentId,
          agentId: f.testAgentId,
          roomId,
          content: { ...content, source: "slack" },
          metadata: { type: "message", platformMessageId: "standup-1" },
        } as Memory;
      },
      resolveTargets: async () => {
        if (slackDiscoveryFails) throw new Error("Slack token was revoked");
        return [
          {
            target: { source: "slack", channelId: "C0STANDUP" },
            label: "eng-standup",
            kind: "channel",
          },
        ];
      },
    });

    const message: Memory = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID,
      agentId: f.testAgentId,
      entityId: userId,
      roomId,
      content: {
        text: "send 'standup in 5' to eng-standup",
        source: "client_chat",
      },
    };
    const send = () =>
      messageAction.handler(f.runtime, message, undefined, {
        parameters: {
          op: "send",
          target: "eng-standup",
          targetKind: "channel",
          message: "standup in 5",
        },
      });

    // Discord discovery is unavailable; the Slack match is still delivered.
    expect(await send()).toMatchObject({
      success: true,
      data: { source: "slack", sourceResolution: "inferred" },
    });
    expect(deliveries).toEqual([{ source: "slack", channelId: "C0STANDUP" }]);

    // Every considered connector failed discovery: the failure surfaces.
    slackDiscoveryFails = true;
    await expect(send()).rejects.toThrow(
      "Discord account client is not initialized",
    );
    expect(deliveries).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

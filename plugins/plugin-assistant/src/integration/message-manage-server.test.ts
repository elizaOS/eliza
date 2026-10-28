/** Proves MESSAGE op=manage_server reaches the hooks a connector registers through runtime.registerMessageConnector. */
import {
  ChannelType,
  type Memory,
  type MessageConnectorManageServerParams,
  type UUID,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { messageAction } from "../features/advanced-capabilities/actions/message";

it("manage_server dispatches to the registered connector's server-management hooks", async () => {
  const runtime = createSQLiteTestRuntime({
    character: { name: "Agent", bio: [] },
    logLevel: "fatal",
  });
  const worldId = "33333333-3333-4333-8333-333333333333" as UUID;
  const messageServerId = "66666666-6666-4666-8666-666666666666" as UUID;
  const roomId = "44444444-4444-4444-8444-444444444444" as UUID;
  const userId = "55555555-5555-4555-8555-555555555555" as UUID;
  const calls: MessageConnectorManageServerParams[] = [];
  try {
    await runtime.initialize();
    await runtime.createEntity({
      id: userId,
      names: ["Admin"],
      agentId: runtime.agentId,
    });
    await runtime.createWorlds([
      {
        id: worldId,
        name: "Acme Discord",
        agentId: runtime.agentId,
        messageServerId,
        metadata: {
          roles: { [userId]: "ADMIN" },
          roleSources: { [userId]: "manual" },
        },
      },
    ]);
    await runtime.createRooms([
      {
        id: roomId,
        name: "general",
        agentId: runtime.agentId,
        source: "discord",
        type: ChannelType.GROUP,
        channelId: "C0GENERAL",
        serverId: "G0ACME",
        messageServerId,
        worldId,
      },
    ]);
    await runtime.addParticipant(userId, roomId);
    await runtime.addParticipant(runtime.agentId, roomId);

    runtime.registerMessageConnector({
      source: "discord",
      accountId: "work",
      label: "Discord",
      capabilities: ["send_message"],
      supportedTargetKinds: ["channel", "server"],
      contexts: ["social"],
      resolveManageServerDestination: (_runtime, { serverId }) => ({
        source: "discord",
        accountId: "work",
        serverId,
        messageServerId,
        destinationWorldId: worldId,
        target: { source: "discord", accountId: "work", serverId },
      }),
      manageServerHandler: async (_runtime, params) => {
        calls.push(params);
        return { summary: "Created #launch.", data: { created: ["launch"] } };
      },
    });

    const message: Memory = {
      id: "77777777-7777-4777-8777-777777777777" as UUID,
      agentId: runtime.agentId,
      entityId: userId,
      roomId,
      content: { text: "make a launch channel", source: "discord" },
    };
    const result = await messageAction.handler(runtime, message, undefined, {
      parameters: {
        action: "manage_server",
        source: "discord",
        operation: "create_channel",
        serverId: "G0ACME",
        name: "launch",
      },
    });

    expect(result).toMatchObject({
      success: true,
      text: "Created #launch.",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: "create_channel",
      serverId: "G0ACME",
      params: { name: "launch" },
      authorization: {
        authorizedEntityId: userId,
        role: "ADMIN",
        bindingRoomIds: [roomId],
      },
    });
  } finally {
    await runtime.stop();
    await runtime.close();
  }
});

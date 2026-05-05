import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SlackService } from "./service";
import type { SlackChannel } from "./types";

function createRuntime() {
  return {
    agentId: "agent-1",
    registerMessageConnector: vi.fn(),
    registerSendHandler: vi.fn(),
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRoom: vi.fn(),
    getEntityById: vi.fn(),
    getRelationships: vi.fn().mockResolvedValue([]),
  } as unknown as IAgentRuntime & {
    registerMessageConnector: ReturnType<typeof vi.fn>;
    registerSendHandler: ReturnType<typeof vi.fn>;
  };
}

describe("Slack message connector adapter", () => {
  it("registers connector metadata with the runtime registry", () => {
    const runtime = createRuntime();
    const service = Object.create(SlackService.prototype) as SlackService & {
      handleSendMessage: ReturnType<typeof vi.fn>;
      resolveConnectorTargets: ReturnType<typeof vi.fn>;
      listRecentConnectorTargets: ReturnType<typeof vi.fn>;
      listConnectorRooms: ReturnType<typeof vi.fn>;
      getConnectorChatContext: ReturnType<typeof vi.fn>;
      getConnectorUserContext: ReturnType<typeof vi.fn>;
    };
    service.handleSendMessage = vi.fn();
    service.resolveConnectorTargets = vi.fn();
    service.listRecentConnectorTargets = vi.fn();
    service.listConnectorRooms = vi.fn();
    service.getConnectorChatContext = vi.fn();
    service.getConnectorUserContext = vi.fn();

    SlackService.registerSendHandlers(runtime, service);

    expect(runtime.registerMessageConnector.mock.calls[0][0]).toMatchObject({
      source: "slack",
      label: "Slack",
      capabilities: expect.arrayContaining([
        "send_message",
        "resolve_targets",
        "chat_context",
        "user_context",
      ]),
      supportedTargetKinds: ["channel", "thread", "user"],
      contexts: ["social", "connectors"],
    });
  });

  it("opens a DM channel when the unified target is a Slack user ID", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({ ts: "1700000000.000001" });
    const service = Object.create(SlackService.prototype) as any;
    service.client = {
      conversations: {
        open: vi.fn().mockResolvedValue({ channel: { id: "D123" } }),
      },
    };
    service.sendMessage = sendMessage;

    await service.handleSendMessage(
      runtime,
      { source: "slack", channelId: "U123ABC" },
      { text: "hello" },
    );

    expect(service.client.conversations.open).toHaveBeenCalledWith({
      users: "U123ABC",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "D123",
      "hello",
      expect.objectContaining({ threadTs: undefined }),
    );
  });

  it("resolves channels and users from Slack API results", async () => {
    const runtime = createRuntime();
    const channel: SlackChannel = {
      id: "C123",
      name: "general",
      isChannel: true,
      isGroup: false,
      isIm: false,
      isMpim: false,
      isPrivate: false,
      isArchived: false,
      isGeneral: true,
      isShared: false,
      isOrgShared: false,
      isMember: true,
      topic: undefined,
      purpose: { value: "Company-wide updates", creator: "U1", lastSet: 1 },
      numMembers: 12,
      created: 1,
      creator: "U1",
    };
    const service = Object.create(SlackService.prototype) as any;
    service.runtime = runtime;
    service.teamId = "T123";
    service.allowedChannelIds = new Set();
    service.dynamicChannelIds = new Set();
    service.listChannels = vi.fn().mockResolvedValue([channel]);
    service.client = {
      users: {
        list: vi.fn().mockResolvedValue({
          members: [
            {
              id: "U234",
              name: "ada",
              real_name: "Ada Lovelace",
              profile: { display_name: "Ada", real_name: "Ada Lovelace" },
            },
          ],
        }),
      },
    };

    const channelTargets = await service.resolveConnectorTargets("general", {
      runtime,
    });
    expect(channelTargets[0]).toMatchObject({
      kind: "channel",
      label: "#general",
      target: { source: "slack", channelId: "C123", serverId: "T123" },
    });

    const userTargets = await service.resolveConnectorTargets("ada", {
      runtime,
    });
    expect(userTargets.some((target: any) => target.kind === "user")).toBe(true);
    expect(
      userTargets.find((target: any) => target.kind === "user")?.target,
    ).toMatchObject({ source: "slack", entityId: "U234" });
  });
});

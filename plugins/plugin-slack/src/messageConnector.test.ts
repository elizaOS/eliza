import type { IAgentRuntime, MessageConnectorTarget } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SlackService } from "./service";
import type { SlackChannel } from "./types";

type MockSlackService = SlackService & {
  handleSendMessage: ReturnType<typeof vi.fn>;
  resolveConnectorTargets: (
    query: string,
    context: { runtime: IAgentRuntime },
  ) => Promise<MessageConnectorTarget[]>;
  listRecentConnectorTargets: ReturnType<typeof vi.fn>;
  listConnectorRooms: ReturnType<typeof vi.fn>;
  getConnectorChatContext: ReturnType<typeof vi.fn>;
  getConnectorUserContext: ReturnType<typeof vi.fn>;
};

function createRuntime() {
  const runtime = {
    agentId: "agent-1",
    registerMessageConnector: vi.fn(),
    registerSendHandler: vi.fn(),
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRoom: vi.fn(),
    getEntityById: vi.fn(),
    getRelationships: vi.fn().mockResolvedValue([]),
  };

  return runtime as IAgentRuntime & {
    registerMessageConnector: ReturnType<typeof vi.fn>;
    registerSendHandler: ReturnType<typeof vi.fn>;
  };
}

describe("Slack message connector adapter", () => {
  it("registers connector metadata with the runtime registry", () => {
    const runtime = createRuntime();
    const service = Object.create(SlackService.prototype) as MockSlackService;
    service.handleSendMessage = vi.fn();
    service.resolveConnectorTargets = vi.fn().mockResolvedValue([]);
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

  it("registers account-scoped and legacy connector routes", () => {
    const runtime = createRuntime();
    const service = Object.assign(
      Object.create(SlackService.prototype) as MockSlackService,
      {
        handleSendMessage: vi.fn(),
        accountStates: new Map([
          [
            "acct-a",
            {
              accountId: "acct-a",
              account: { accountId: "acct-a", name: "A" },
              teamId: "TA",
            },
          ],
          [
            "acct-b",
            {
              accountId: "acct-b",
              account: { accountId: "acct-b", name: "B" },
              teamId: "TB",
            },
          ],
        ]),
        defaultAccountId: "acct-a",
      },
    );

    SlackService.registerSendHandlers(runtime, service);

    const registrations = runtime.registerMessageConnector.mock.calls.map(
      (call) => call[0],
    );
    expect(registrations.map((registration) => registration.accountId)).toEqual(
      [undefined, "acct-a", "acct-b"],
    );
    expect(registrations[1]).toMatchObject({
      source: "slack",
      accountId: "acct-a",
      account: { accountId: "acct-a" },
      metadata: { accountId: "acct-a" },
    });
  });

  it("opens a DM channel when the unified target is a Slack user ID", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({ ts: "1700000000.000001" });
    const service = Object.assign(
      Object.create(SlackService.prototype) as SlackService,
      {
        client: {
          conversations: {
            open: vi.fn().mockResolvedValue({ channel: { id: "D123" } }),
          },
        },
        sendMessage,
      },
    );

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
      "default",
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
    const service = Object.assign(
      Object.create(SlackService.prototype) as SlackService,
      {
        runtime,
        teamId: "T123",
        allowedChannelIds: new Set<string>(),
        dynamicChannelIds: new Set<string>(),
        listChannels: vi.fn().mockResolvedValue([channel]),
        client: {
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
        },
      },
    );

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
    expect(userTargets.some((target) => target.kind === "user")).toBe(true);
    expect(
      userTargets.find((target) => target.kind === "user")?.target,
    ).toMatchObject({ source: "slack", entityId: "U234" });
  });

  it("routes outbound DMs through the requested account client", async () => {
    const runtime = createRuntime();
    const clientA = {
      conversations: {
        open: vi.fn().mockResolvedValue({ channel: { id: "DA" } }),
      },
    };
    const clientB = {
      conversations: {
        open: vi.fn().mockResolvedValue({ channel: { id: "DB" } }),
      },
    };
    const sendMessage = vi.fn().mockResolvedValue({ ts: "1700000000.000002" });
    const service = Object.assign(
      Object.create(SlackService.prototype) as SlackService,
      {
        client: clientA,
        defaultAccountId: "acct-a",
        accountStates: new Map([
          ["acct-a", { accountId: "acct-a", client: clientA }],
          ["acct-b", { accountId: "acct-b", client: clientB }],
        ]),
        sendMessage,
      },
    );

    await service.handleSendMessage(
      runtime,
      { source: "slack", accountId: "acct-b", channelId: "U123ABC" },
      { text: "hello" },
    );

    expect(clientA.conversations.open).not.toHaveBeenCalled();
    expect(clientB.conversations.open).toHaveBeenCalledWith({
      users: "U123ABC",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "DB",
      "hello",
      expect.any(Object),
      "acct-b",
    );
  });
});

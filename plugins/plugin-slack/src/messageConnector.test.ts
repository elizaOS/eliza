/**
 * Unit tests for `SlackService`'s message-connector surface — target
 * resolution, recent-target and room listing, and chat/user context — driven
 * against a `SlackService` instance with its Slack-facing methods stubbed. No
 * live Slack API.
 */
import type { IAgentRuntime, MessageConnectorTarget } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { compareSlackConnectorTargets, SlackService } from "./service";
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
    createEntity: vi.fn(),
    createMemory: vi.fn(),
    emitEvent: vi.fn(),
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
        defaultAccountId: "default",
        accountStates: new Map([
          [
            "default",
            {
              accountId: "default",
              teamId: "T123",
              policy: { isChannelAllowed: () => true },
            },
          ],
        ]),
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

  it("preserves every matching and listed connector target", async () => {
    const runtime = createRuntime();
    const channels = Array.from({ length: 60 }, (_, index) => ({
      id: `C${index}`,
      name: `project-${index}`,
      isChannel: true,
      isGroup: false,
      isIm: false,
      isMpim: false,
      isPrivate: false,
      isArchived: false,
      isGeneral: index === 0,
      isShared: false,
      isOrgShared: false,
      isMember: true,
      topic: undefined,
      purpose: undefined,
      numMembers: 1,
      created: 1,
      creator: "U1",
    })) satisfies SlackChannel[];
    const service = Object.assign(
      Object.create(SlackService.prototype) as SlackService,
      {
        runtime,
        teamId: "T123",
        defaultAccountId: "default",
        accountStates: new Map([
          [
            "default",
            {
              accountId: "default",
              teamId: "T123",
              policy: { isChannelAllowed: () => true },
            },
          ],
        ]),
        listChannels: vi.fn().mockResolvedValue(channels),
        client: {
          users: { list: vi.fn().mockResolvedValue({ members: [] }) },
        },
      },
    );

    const matches = await service.resolveConnectorTargets("project", {
      runtime,
    });
    const rooms = await service.listConnectorRooms({ runtime });
    const recent = await service.listRecentConnectorTargets({ runtime });

    expect(matches).toHaveLength(60);
    expect(rooms).toHaveLength(60);
    expect(recent).toHaveLength(60);
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

  it("ignores malformed Slack message and mention events before creating memories", async () => {
    const runtime = createRuntime();
    const service = Object.assign(
      Object.create(SlackService.prototype) as SlackService,
      {
        runtime,
        settings: {
          allowedChannelIds: undefined,
          shouldIgnoreBotMessages: false,
          shouldRespondOnlyToMentions: false,
        },
        defaultAccountId: "default",
        allowedChannelIds: new Set<string>(),
        dynamicChannelIds: new Set<string>(),
        accountStates: new Map(),
        botUserId: "U00000000",
        teamId: "T12345678",
      },
    );

    await (
      service as unknown as {
        handleMessage: (...args: unknown[]) => Promise<void>;
      }
    ).handleMessage(
      {
        type: "message",
        channel: "../../etc/passwd",
        user: "U12345678",
        text: "hostile",
        ts: "not-a-ts",
      },
      {},
    );
    await (
      service as unknown as {
        handleAppMention: (...args: unknown[]) => Promise<void>;
      }
    ).handleAppMention(
      {
        type: "app_mention",
        channel: "C12345678",
        user: "<script>",
        text: "<@U00000000> hi",
        ts: "1700000000",
        event_ts: "1700000000",
      },
      {},
    );

    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(runtime.createEntity).not.toHaveBeenCalled();
    expect(runtime.emitEvent).not.toHaveBeenCalled();
    expect(runtime.logger.warn).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid connector mutation payloads before calling Slack APIs", async () => {
    const runtime = createRuntime();
    const client = {
      reactions: {
        add: vi.fn(),
        remove: vi.fn(),
      },
      chat: {
        update: vi.fn(),
        delete: vi.fn(),
      },
      pins: {
        add: vi.fn(),
        remove: vi.fn(),
      },
    };
    const service = Object.assign(
      Object.create(SlackService.prototype) as SlackService,
      {
        runtime,
        client,
        defaultAccountId: "default",
        accountStates: new Map(),
      },
    );

    await expect(
      service.reactConnectorMessage(runtime, {
        channelId: "C12345678",
        messageTs: "bad-ts",
        emoji: ":white_check_mark:",
      }),
    ).rejects.toThrow(/reaction requires/i);
    await expect(
      service.reactConnectorMessage(runtime, {
        channelId: "C12345678",
        messageTs: "1700000000.000001",
        emoji: "::",
      }),
    ).rejects.toThrow(/reaction requires/i);
    await expect(
      service.editConnectorMessage(runtime, {
        channelId: "C12345678",
        messageTs: "1700000000",
        text: "edited",
      }),
    ).rejects.toThrow(/edit requires/i);
    await expect(
      service.deleteConnectorMessage(runtime, {
        channelId: "C12345678",
        messageTs: "1700000000",
      }),
    ).rejects.toThrow(/delete requires/i);
    await expect(
      service.pinConnectorMessage(runtime, {
        channelId: "C12345678",
        messageTs: "1700000000",
      }),
    ).rejects.toThrow(/pin requires/i);

    expect(client.reactions.add).not.toHaveBeenCalled();
    expect(client.reactions.remove).not.toHaveBeenCalled();
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.chat.delete).not.toHaveBeenCalled();
    expect(client.pins.add).not.toHaveBeenCalled();
    expect(client.pins.remove).not.toHaveBeenCalled();
  });

  it("normalizes hostile fetch and search limits before reading Slack history", async () => {
    const runtime = createRuntime();
    const messages = Array.from({ length: 4 }, (_, index) => ({
      ts: `170000000${index}.000001`,
      text: index % 2 === 0 ? "incident followup" : "hello",
      user: "U123ABC",
    }));
    const service = Object.assign(
      Object.create(SlackService.prototype) as SlackService,
      {
        runtime,
        client: {},
        defaultAccountId: "default",
        accountStates: new Map(),
        readHistory: vi.fn(async () => messages),
        slackMessageToMemory: vi.fn(
          async (message: { ts: string; text: string }) => ({
            id: message.ts,
            roomId: "room-1",
            entityId: "entity-1",
            content: { text: message.text },
            createdAt: Number(message.ts.split(".")[0]),
          }),
        ),
      },
    );

    const fetched = await service.fetchConnectorMessages(
      { runtime },
      { channelId: "C12345678", limit: 1.9 },
    );
    const searched = await service.searchConnectorMessages(
      { runtime },
      {
        channelId: "C12345678",
        query: "incident",
        limit: Number.NEGATIVE_INFINITY,
      },
    );

    expect(service.readHistory).toHaveBeenNthCalledWith(
      1,
      "C12345678",
      expect.objectContaining({ limit: 1 }),
      "default",
    );
    expect(service.readHistory).toHaveBeenNthCalledWith(
      2,
      "C12345678",
      expect.objectContaining({ limit: 100 }),
      "default",
    );
    expect(fetched).toHaveLength(4);
    expect(searched).toHaveLength(2);
  });
});

describe("compareSlackConnectorTargets", () => {
  const at = (
    label: string,
    score: number,
    channelId: string,
  ): MessageConnectorTarget =>
    ({
      label,
      score,
      target: { source: "slack", channelId },
    }) as unknown as MessageConnectorTarget;

  it("orders the highest score first", () => {
    const targets = [at("low", 0.1, "C1"), at("high", 0.9, "C2")];
    targets.sort(compareSlackConnectorTargets);
    expect(targets.map((t) => t.label)).toEqual(["high", "low"]);
  });

  it("keeps a total order when a score is not finite", () => {
    const targets = [at("nan", Number.NaN, "C1"), at("valid", 0.9, "C2")];
    targets.sort(compareSlackConnectorTargets);
    expect(targets.map((t) => t.label)).toEqual(["valid", "nan"]);

    expect(
      compareSlackConnectorTargets(
        at("nan", Number.NaN, "C1"),
        at("valid", 0.9, "C2"),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareSlackConnectorTargets(
        at("valid", 0.9, "C2"),
        at("nan", Number.NaN, "C1"),
      ),
    ).toBeLessThan(0);
  });

  it("tie-breaks equal scores on label", () => {
    const targets = [at("z-label", 0.5, "C1"), at("a-label", 0.5, "C2")];
    targets.sort(compareSlackConnectorTargets);
    expect(targets.map((t) => t.label)).toEqual(["a-label", "z-label"]);
  });
});

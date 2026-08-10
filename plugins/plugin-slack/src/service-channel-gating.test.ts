/**
 * Integration coverage for persisted Slack config through Character projection,
 * account startup, directory compilation, and the callbacks registered on Bolt.
 * Downstream agent work is replaced only after startup so admission exercises
 * the production boot and handler path.
 */
import {
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type Room,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectConnectorSettings } from "../../../packages/agent/src/runtime/project-connector-settings";

const bolt = vi.hoisted(() => ({
  apps: [] as Array<{
    messageHandler?: (args: {
      message: unknown;
      client: unknown;
      body?: unknown;
    }) => Promise<void>;
    eventHandlers: Map<
      string,
      (args: {
        event: unknown;
        client: unknown;
        body?: unknown;
      }) => Promise<void>
    >;
    client: ReturnType<typeof createClient>;
  }>,
  channels: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
  infoError: null as Error | null,
  authResult: {
    user_id: "U0BOTBOT0",
    team_id: "T0TEAM000",
  } as Record<string, unknown>,
}));

function createClient() {
  return {
    auth: {
      test: vi.fn().mockImplementation(async () => bolt.authResult),
    },
    conversations: {
      list: vi
        .fn()
        .mockImplementation(async () => ({ channels: bolt.channels })),
      info: vi
        .fn()
        .mockImplementation(async ({ channel }: { channel: string }) => {
          if (bolt.infoError) throw bolt.infoError;
          return {
            channel: bolt.channels.find((entry) => entry.id === channel),
          };
        }),
    },
    users: {
      list: vi.fn().mockImplementation(async () => ({ members: bolt.users })),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1.000001" }),
    },
    team: { info: vi.fn().mockResolvedValue({ team: { name: "Sandbox" } }) },
  };
}

vi.mock("@slack/bolt", () => ({
  LogLevel: { INFO: "info" },
  App: class MockBoltApp {
    client = createClient();
    private readonly record = {
      eventHandlers: new Map<
        string,
        (args: {
          event: unknown;
          client: unknown;
          body?: unknown;
        }) => Promise<void>
      >(),
      client: this.client,
    } as (typeof bolt.apps)[number];

    constructor() {
      bolt.apps.push(this.record);
    }

    message(
      handler: (args: {
        message: unknown;
        client: unknown;
        body?: unknown;
      }) => Promise<void>,
    ) {
      this.record.messageHandler = (args) =>
        handler({
          ...args,
          body:
            args.body ?? slackEnvelope(args.message as Record<string, unknown>),
        });
    }

    event(
      name: string,
      handler: (args: {
        event: unknown;
        client: unknown;
        body?: unknown;
      }) => Promise<void>,
    ) {
      this.record.eventHandlers.set(name, (args) =>
        handler({
          ...args,
          body:
            args.body ?? slackEnvelope(args.event as Record<string, unknown>),
        }),
      );
    }

    async start() {}
    async stop() {}
  },
}));

import { SlackService } from "./service";

const OPS = "C0123ABCD";
const DISABLED = "G0123ABCD";
const UNKNOWN = "C0999ZZZZ";
const DM = "D0123ABCD";
const MPIM = "G0MPIM123";
const ALICE = "U0123ABCD";
const BOB = "U0999ZZZZ";

function slackEnvelope(event: Record<string, unknown>) {
  const identity = [
    event.type,
    event.channel,
    event.user,
    event.ts,
    event.event_ts,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(":");
  return {
    team_id: "T0TEAM000",
    event_id: `Ev-${identity}`,
    event,
  };
}

type SlackConnectorInput = Record<string, unknown>;

function createPersistedConfig(slack: SlackConnectorInput) {
  return {
    logging: { level: "error" },
    connectors: { slack },
  };
}

function createRuntime(slack: SlackConnectorInput): IAgentRuntime {
  const persisted = createPersistedConfig(slack);
  const projection = projectConnectorSettings({}, persisted.connectors);
  const character = {
    name: "Slack Policy Test",
    settings: projection.settings,
    secrets: projection.secrets,
  };
  const memories = new Map<string, Memory>();
  const runtime = {
    agentId: "agent-slack-policy-integration",
    character,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn((key: string) => {
      const settings = character.settings as Record<string, unknown>;
      return settings[key] ?? character.secrets[key] ?? null;
    }),
    getWorld: vi.fn().mockResolvedValue({ id: "world-existing" }),
    emitEvent: vi.fn().mockResolvedValue(undefined),
    createMemory: vi.fn().mockImplementation(async (memory: Memory) => {
      if (memory.id && !memories.has(memory.id)) {
        memories.set(memory.id, structuredClone(memory));
      }
      return memory.id;
    }),
    getMemoryById: vi
      .fn()
      .mockImplementation(async (id: string) => memories.get(id) ?? null),
    createEntity: vi.fn().mockResolvedValue(undefined),
    getEntityById: vi.fn().mockResolvedValue({ id: "entity-existing" }),
    reportError: vi.fn(),
    __testMemories: memories,
  };
  return runtime as unknown as IAgentRuntime;
}

async function startHarness(overrides: SlackConnectorInput = {}) {
  const runtime = createRuntime({
    enabled: true,
    botToken: "xoxb-test-token",
    appToken: "xapp-test-token",
    groupPolicy: "allowlist",
    requireMention: true,
    allowBots: false,
    channels: {
      ops: { users: ["alice"] },
      leadership: { enabled: false },
      "*": { enabled: false },
    },
    dm: {
      policy: "allowlist",
      allowFrom: [ALICE],
      groupEnabled: false,
    },
    ...overrides,
  });
  const service = await SlackService.start(runtime);
  const processAgentMessage = vi.fn().mockResolvedValue(undefined);
  const buildRawMessageMemory = (
    service as unknown as {
      buildMemoryFromMessage(
        event: ReturnType<typeof message>,
        accountId: string,
      ): Promise<Memory | null>;
    }
  ).buildMemoryFromMessage.bind(service);
  Object.assign(service, {
    processAgentMessage,
    buildMemoryFromMessage: vi.fn().mockResolvedValue({
      id: "memory-1",
      agentId: runtime.agentId,
      roomId: "room-1",
      entityId: "entity-existing",
      content: { text: "message" },
      metadata: {},
    }),
    buildMemoryFromMention: vi.fn().mockResolvedValue({
      id: "memory-2",
      agentId: runtime.agentId,
      roomId: "room-1",
      entityId: "entity-existing",
      content: { text: "mention" },
      metadata: {},
    }),
    ensureRoomExists: vi.fn().mockResolvedValue({ id: "room-1" }),
  });
  const app = bolt.apps.at(-1);
  if (!app?.messageHandler)
    throw new Error("Bolt message handler was not registered");
  return {
    app,
    buildRawMessageMemory,
    processAgentMessage,
    runtime,
    service,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    channel: OPS,
    channel_type: "channel",
    user: ALICE,
    text: "status?",
    ts: "1700000000.000100",
    ...overrides,
  };
}

function mention(overrides: Record<string, unknown> = {}) {
  return {
    type: "app_mention",
    channel: OPS,
    user: ALICE,
    text: "<@U0BOTBOT0> status?",
    ts: "1700000000.000100",
    event_ts: "1700000000.000100",
    ...overrides,
  };
}

function reaction(overrides: Record<string, unknown> = {}) {
  return {
    user: ALICE,
    reaction: "thumbsup",
    item: {
      type: "message",
      channel: OPS,
      ts: "1700000000.000100",
    },
    item_user: "U0BOTBOT0",
    event_ts: "1700000001.000200",
    ...overrides,
  };
}

beforeEach(() => {
  bolt.apps.length = 0;
  bolt.channels = [
    { id: OPS, name: "ops", is_channel: true },
    { id: DISABLED, name: "leadership", is_private: true, is_group: true },
    { id: UNKNOWN, name: "random", is_channel: true },
    { id: DM, is_im: true },
    { id: MPIM, name: "mpdm-team", is_mpim: true },
  ];
  bolt.users = [
    { id: ALICE, name: "alice", profile: { display_name: "Alice" } },
    { id: BOB, name: "bob", profile: { display_name: "Bob" } },
  ];
  bolt.infoError = null;
  bolt.authResult = { user_id: "U0BOTBOT0", team_id: "T0TEAM000" };
});

describe("persisted Slack policy through Bolt handlers", () => {
  it("claims a retried event once before persistence, emission, processing, and response", async () => {
    const harness = await startHarness();
    const appMention = harness.app.eventHandlers.get("app_mention");
    if (!appMention) throw new Error("app_mention handler was not registered");
    harness.processAgentMessage.mockImplementation(async () => {
      await harness.app.client.chat.postMessage({
        channel: OPS,
        text: "acknowledged",
      });
    });
    const event = mention();
    const body = {
      team_id: "T0TEAM000",
      event_id: "Ev-retried-delivery",
      event,
    };

    await Promise.all([
      appMention({ event, client: harness.app.client, body }),
      appMention({ event, client: harness.app.client, body }),
    ]);

    const memories = (
      harness.runtime as IAgentRuntime & { __testMemories: Map<string, Memory> }
    ).__testMemories;
    expect(memories.size).toBe(1);
    expect(harness.runtime.createMemory).toHaveBeenCalledTimes(2);
    expect(harness.runtime.emitEvent).toHaveBeenCalledTimes(1);
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
    expect(harness.app.client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("projects canonical connector config and enforces name-resolved policy", async () => {
    const harness = await startHarness();
    expect(harness.runtime.character.settings?.slack).toMatchObject({
      groupPolicy: "allowlist",
      channels: { ops: { users: ["alice"] } },
    });

    await harness.app.messageHandler?.({
      message: message(),
      client: harness.app.client,
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();

    const appMention = harness.app.eventHandlers.get("app_mention");
    await appMention?.({ event: mention(), client: harness.app.client });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);

    await appMention?.({
      event: mention({ user: BOB }),
      client: harness.app.client,
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("denies a disabled name-keyed channel on the first event", async () => {
    const harness = await startHarness();
    const appMention = harness.app.eventHandlers.get("app_mention");
    await appMention?.({
      event: mention({ channel: DISABLED }),
      client: harness.app.client,
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("applies DM policy to App Home and group-DM policy to MPIM", async () => {
    const harness = await startHarness();
    await harness.app.messageHandler?.({
      message: message({
        channel: DM,
        channel_type: "app_home",
        subtype: "app_home",
        text: "hello",
      }),
      client: harness.app.client,
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);

    await harness.app.messageHandler?.({
      message: message({ channel: MPIM, channel_type: "mpim", text: "hello" }),
      client: harness.app.client,
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("does not let a member_joined_channel event admit an unconfigured channel", async () => {
    const harness = await startHarness();
    const joined = harness.app.eventHandlers.get("member_joined_channel");
    await joined?.({
      event: { user: "U0BOTBOT0", channel: UNKNOWN, team: "T0TEAM000" },
      client: harness.app.client,
    });
    const appMention = harness.app.eventHandlers.get("app_mention");
    await appMention?.({
      event: mention({ channel: UNKNOWN }),
      client: harness.app.client,
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("fails account startup when persisted security config is unsupported", async () => {
    const runtime = createRuntime({
      enabled: true,
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
      groupPolicy: "allowlist",
      actions: { messages: false },
    });
    await expect(SlackService.start(runtime)).rejects.toThrow(
      /cannot enforce: actions/,
    );
    expect(bolt.apps[0]?.eventHandlers.size).toBe(0);
  });

  it("fails startup when Slack does not authenticate a workspace identity", async () => {
    bolt.authResult = { user_id: "U0BOTBOT0" };
    const runtime = createRuntime({
      enabled: true,
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
      groupPolicy: "open",
    });
    await expect(SlackService.start(runtime)).rejects.toMatchObject({
      code: "SLACK_AUTH_IDENTITY_MISSING",
    });
    expect(bolt.apps[0]?.eventHandlers.size).toBe(0);
  });

  it("rejects missing and foreign workspace identity on every inbound family", async () => {
    const harness = await startHarness();
    const appMention = harness.app.eventHandlers.get("app_mention");
    await appMention?.({
      event: mention(),
      client: harness.app.client,
      body: {},
    });
    await appMention?.({
      event: mention(),
      client: harness.app.client,
      body: { team_id: "foreign-workspace", event: mention() },
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();

    const fixtures: Record<string, Record<string, unknown>> = {
      reaction_added: {
        user: ALICE,
        reaction: "thumbsup",
        item: { type: "message", channel: OPS, ts: "1700000000.000100" },
      },
      reaction_removed: {
        user: ALICE,
        reaction: "thumbsup",
        item: { type: "message", channel: OPS, ts: "1700000000.000100" },
      },
      member_joined_channel: {
        user: "U0BOTBOT0",
        channel: UNKNOWN,
      },
      member_left_channel: { user: "U0BOTBOT0", channel: UNKNOWN },
      file_shared: { file_id: "file", user_id: ALICE, channel_id: OPS },
    };
    for (const [name, event] of Object.entries(fixtures)) {
      await harness.app.eventHandlers.get(name)?.({
        event,
        client: harness.app.client,
        body: { team_id: "foreign-workspace", event },
      });
    }
    expect(harness.runtime.emitEvent).not.toHaveBeenCalled();
  });

  it("bridges authorized reactions with stable identity and the stored thread lane", async () => {
    const harness = await startHarness();
    const target = {
      id: "target-memory",
      roomId: "thread-room",
      entityId: harness.runtime.agentId,
      content: { text: "target" },
      metadata: { slackThreadTs: "1700000000.000100" },
    };
    vi.mocked(harness.runtime.getMemoryById).mockResolvedValue(target);
    const handler = harness.app.eventHandlers.get("reaction_added");

    await handler?.({ event: reaction(), client: harness.app.client });
    const firstPayload = vi
      .mocked(harness.runtime.emitEvent)
      .mock.calls.at(-1)?.[1];
    expect(vi.mocked(harness.runtime.emitEvent).mock.calls.at(-1)?.[0]).toEqual(
      ["SLACK_REACTION_ADDED", "REACTION_RECEIVED"],
    );
    expect(firstPayload).toMatchObject({
      reaction: "thumbsup",
      userId: ALICE,
      channelId: OPS,
      messageTs: "1700000000.000100",
      message: {
        roomId: "thread-room",
        content: { inReplyTo: "target-memory" },
        metadata: {
          slackThreadTs: "1700000000.000100",
          slackReaction: { action: "added", itemUser: "U0BOTBOT0" },
        },
      },
    });

    await handler?.({ event: reaction(), client: harness.app.client });
    const secondPayload = vi
      .mocked(harness.runtime.emitEvent)
      .mock.calls.at(-1)?.[1];
    expect(secondPayload?.message.id).toBe(firstPayload?.message.id);
  });

  it("fails closed for malformed, unauthorized, and non-owned reactions", async () => {
    const harness = await startHarness();
    vi.mocked(harness.runtime.getMemoryById).mockResolvedValue({
      id: "target-memory",
      roomId: "room-1",
      entityId: "external-entity",
      content: { text: "target" },
    });
    const handler = harness.app.eventHandlers.get("reaction_added");

    await handler?.({
      event: reaction({ item: { channel: OPS, ts: "1700000000.000100" } }),
      client: harness.app.client,
    });
    await handler?.({
      event: reaction({ event_ts: undefined }),
      client: harness.app.client,
    });
    await handler?.({
      event: reaction({ user: BOB }),
      client: harness.app.client,
    });
    await handler?.({
      event: reaction({ user: "U0BOTBOT0" }),
      client: harness.app.client,
    });
    await handler?.({
      event: reaction({ item_user: BOB }),
      client: harness.app.client,
    });
    await handler?.({
      event: reaction({
        user: BOB,
        item: { type: "message", channel: DM, ts: "1700000000.000100" },
      }),
      client: harness.app.client,
    });
    expect(harness.runtime.emitEvent).not.toHaveBeenCalled();
  });

  it("accepts an authorized bot event as a bot-authored memory", async () => {
    const harness = await startHarness({ allowBots: true });
    Object.assign(harness.service, {
      getRoomId: vi.fn().mockResolvedValue("room-bot"),
    });

    const memory = await harness.buildRawMessageMemory(
      message({ user: undefined, bot_id: "B0123BOT", text: "bot update" }),
      "default",
    );

    expect(memory).toMatchObject({
      entityId: expect.any(String),
      content: { text: "bot update", name: "B0123BOT" },
      metadata: {
        fromBot: true,
        fromId: "B0123BOT",
        sender: { id: "B0123BOT" },
      },
    });
  });

  it("treats an OWNER user-token post as agent-owned", async () => {
    const harness = await startHarness({
      role: "OWNER",
      userToken: "xoxp-owner-token",
    });
    vi.mocked(harness.runtime.getMemoryById).mockResolvedValue({
      id: "owner-target",
      roomId: "room-1",
      entityId: harness.runtime.agentId,
      content: { text: "owner-authored reply" },
    });

    await harness.app.eventHandlers.get("reaction_added")?.({
      event: reaction({ item_user: BOB }),
      client: harness.app.client,
    });

    expect(harness.runtime.emitEvent).toHaveBeenCalledWith(
      expect.arrayContaining(["REACTION_RECEIVED"]),
      expect.objectContaining({ messageTs: "1700000000.000100" }),
    );
  });

  it("keeps removals plugin-local until core defines a removal contract", async () => {
    const harness = await startHarness();
    vi.mocked(harness.runtime.getMemoryById).mockResolvedValue({
      id: "target-memory",
      roomId: "room-1",
      entityId: harness.runtime.agentId,
      content: { text: "target" },
    });
    await harness.app.eventHandlers.get("reaction_removed")?.({
      event: reaction(),
      client: harness.app.client,
    });
    expect(harness.runtime.emitEvent).toHaveBeenCalledWith(
      "SLACK_REACTION_REMOVED",
      expect.objectContaining({
        message: expect.objectContaining({
          metadata: expect.objectContaining({
            slackReaction: expect.objectContaining({ action: "removed" }),
          }),
        }),
      }),
    );
  });

  it("applies configured reaction-name policy after channel user policy", async () => {
    const harness = await startHarness({
      reactionNotifications: "allowlist",
      reactionAllowlist: ["eyes"],
    });
    vi.mocked(harness.runtime.getMemoryById).mockResolvedValue({
      id: "target-memory",
      roomId: "room-1",
      entityId: harness.runtime.agentId,
      content: { text: "target" },
    });
    const handler = harness.app.eventHandlers.get("reaction_added");
    await handler?.({ event: reaction(), client: harness.app.client });
    expect(harness.runtime.emitEvent).not.toHaveBeenCalled();

    await handler?.({
      event: reaction({ reaction: "eyes", item_user: BOB }),
      client: harness.app.client,
    });
    expect(harness.runtime.emitEvent).toHaveBeenCalledTimes(1);
  });

  it("reports database failures and refuses ambiguous target lanes", async () => {
    const harness = await startHarness();
    const handler = harness.app.eventHandlers.get("reaction_added");
    vi.mocked(harness.runtime.getMemoryById).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(
      handler?.({ event: reaction(), client: harness.app.client }),
    ).rejects.toThrow("Slack reaction bridge failed");
    expect(harness.runtime.reportError).toHaveBeenCalledWith(
      "slack-reaction-bridge",
      expect.objectContaining({ code: "SLACK_REACTION_BRIDGE_FAILED" }),
    );

    vi.mocked(harness.runtime.getMemoryById)
      .mockReset()
      .mockResolvedValueOnce({
        id: "target-one",
        roomId: "room-one",
        entityId: harness.runtime.agentId,
        content: { text: "target" },
      })
      .mockResolvedValueOnce({
        id: "target-two",
        roomId: "room-two",
        entityId: harness.runtime.agentId,
        content: { text: "target" },
      })
      .mockResolvedValueOnce(null);
    await expect(
      handler?.({ event: reaction(), client: harness.app.client }),
    ).rejects.toThrow("Slack reaction bridge failed");
    expect(harness.runtime.reportError).toHaveBeenLastCalledWith(
      "slack-reaction-bridge",
      expect.objectContaining({
        cause: expect.objectContaining({
          code: "SLACK_REACTION_TARGET_AMBIGUOUS",
        }),
      }),
    );
  });

  it("persists outbound Slack timestamps in the exact thread lane", async () => {
    const runtime = createRuntime({
      enabled: true,
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
      groupPolicy: "open",
      dm: { policy: "open", allowFrom: ["*"] },
    });
    Object.assign(runtime, {
      messageService: {
        handleMessage: async (
          _runtime: IAgentRuntime,
          _memory: Memory,
          callback: HandlerCallback,
        ) => callback({ text: "acknowledged" }),
      },
    });
    const service = await SlackService.start(runtime);
    Object.assign(service, {
      ensureRoomExists: vi.fn().mockResolvedValue({ id: "thread-room" }),
    });
    const app = bolt.apps.at(-1);
    vi.mocked(app?.client.chat.postMessage).mockResolvedValueOnce({
      ok: true,
      ts: "1700000002.000300",
    });
    const inputMemory = {
      id: "input-memory",
      entityId: "input-entity",
      agentId: runtime.agentId,
      roomId: "channel-room",
      content: { text: "hello" },
    } as Memory;
    await (
      service as unknown as {
        processAgentMessage(
          memory: Memory,
          room: Room,
          channelId: string,
          threadTs: string,
          accountId: string,
        ): Promise<void>;
      }
    ).processAgentMessage(
      inputMemory,
      { id: "channel-room" } as Room,
      OPS,
      "1700000000.000100",
      "default",
    );

    expect(runtime.createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: createUniqueUuid(runtime, `slack-${OPS}-1700000002.000300`),
        roomId: "thread-room",
        createdAt: 1700000002000,
        metadata: expect.objectContaining({
          slackMessageTs: "1700000002.000300",
          slackThreadTs: "1700000000.000100",
          fromBot: true,
        }),
      }),
      "messages",
    );
  });

  it("reports and rethrows channel lookup failures from the Bolt callback", async () => {
    const harness = await startHarness({
      groupPolicy: "open",
      channels: { [OPS]: {} },
      dm: { policy: "open", allowFrom: ["*"] },
    });
    bolt.infoError = new Error("conversations.info unavailable");
    const appMention = harness.app.eventHandlers.get("app_mention");

    await expect(
      appMention?.({
        event: mention(),
        client: harness.app.client,
      }),
    ).rejects.toThrow("Slack inbound policy resolution failed");
    expect(harness.runtime.reportError).toHaveBeenCalledWith(
      "slack-inbound-policy",
      expect.objectContaining({
        code: "SLACK_INBOUND_POLICY_RESOLUTION_FAILED",
      }),
    );
  });
});

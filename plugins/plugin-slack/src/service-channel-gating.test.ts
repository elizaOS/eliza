/**
 * Integration coverage for persisted Slack config through Character projection,
 * account startup, directory compilation, and the callbacks registered on Bolt.
 * Downstream agent work is replaced only after startup so admission exercises
 * the production boot and handler path.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectConnectorSettings } from "../../../packages/agent/src/runtime/project-connector-settings";

const bolt = vi.hoisted(() => ({
  apps: [] as Array<{
    messageHandler?: (args: {
      message: unknown;
      client: unknown;
    }) => Promise<void>;
    eventHandlers: Map<
      string,
      (args: { event: unknown; client: unknown }) => Promise<void>
    >;
    client: ReturnType<typeof createClient>;
  }>,
  channels: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
  infoError: null as Error | null,
}));

function createClient() {
  return {
    auth: {
      test: vi.fn().mockResolvedValue({
        user_id: "U0BOTBOT0",
        team_id: "T0TEAM000",
      }),
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
        (args: { event: unknown; client: unknown }) => Promise<void>
      >(),
      client: this.client,
    } as (typeof bolt.apps)[number];

    constructor() {
      bolt.apps.push(this.record);
    }

    message(
      handler: (args: { message: unknown; client: unknown }) => Promise<void>,
    ) {
      this.record.messageHandler = handler;
    }

    event(
      name: string,
      handler: (args: { event: unknown; client: unknown }) => Promise<void>,
    ) {
      this.record.eventHandlers.set(name, handler);
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
    createMemory: vi.fn().mockResolvedValue(undefined),
    createEntity: vi.fn().mockResolvedValue(undefined),
    getEntityById: vi.fn().mockResolvedValue({ id: "entity-existing" }),
    reportError: vi.fn(),
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
  Object.assign(service, {
    processAgentMessage,
    buildMemoryFromMessage: vi.fn().mockResolvedValue({
      id: "memory-1",
      entityId: "entity-existing",
    }),
    buildMemoryFromMention: vi.fn().mockResolvedValue({
      id: "memory-2",
      entityId: "entity-existing",
    }),
    ensureRoomExists: vi.fn().mockResolvedValue({ id: "room-1" }),
  });
  const app = bolt.apps.at(-1);
  if (!app?.messageHandler)
    throw new Error("Bolt message handler was not registered");
  return { app, processAgentMessage, runtime, service };
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
});

describe("persisted Slack policy through Bolt handlers", () => {
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

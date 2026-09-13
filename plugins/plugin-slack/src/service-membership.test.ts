/**
 * Service-level membership tests through the real Bolt event-registration
 * path: member join/leave payloads preserve user and channel, joins renew
 * runtime participation only for admitted channels, leaves remove only the
 * room participant, and inbound messages renew the sender's connection.
 * The Bolt app and WebClient are mocked; the SlackService under test is real.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectConnectorSettings } from "../../../packages/agent/src/runtime/project-connector-settings";

const bolt = vi.hoisted(() => ({
  channels: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
}));

function createClient() {
  return {
    auth: {
      test: vi
        .fn()
        .mockResolvedValue({ user_id: "U0BOTBOT0", team_id: "T0TEAM000" }),
    },
    conversations: {
      list: vi.fn().mockResolvedValue({ channels: bolt.channels }),
      info: vi
        .fn()
        .mockImplementation(async ({ channel }: { channel: string }) => ({
          channel: bolt.channels.find((entry) => entry.id === channel),
        })),
      members: vi.fn(),
      history: vi.fn().mockResolvedValue({
        // Newest-first, as Slack returns. The thread PARENT (ts .000000)
        // is part of the channel transcript — the same message
        // conversations.replies repeats first.
        messages: [
          {
            type: "message",
            subtype: undefined,
            ts: "1700000000.000001",
            user: ALICE,
            text: "channel message",
          },
          {
            type: "message",
            subtype: undefined,
            ts: "1700000000.000000",
            user: ALICE,
            text: "thread parent",
          },
        ],
      }),
      replies: vi.fn().mockResolvedValue({
        // Realistic Slack shape per docs: conversations.replies returns
        // EARLIEST-FIRST — the thread PARENT first, then replies in
        // chronological order.
        messages: [
          {
            type: "message",
            subtype: undefined,
            ts: "1700000000.000000",
            user: ALICE,
            text: "thread parent",
          },
          {
            type: "message",
            subtype: undefined,
            ts: "1700000000.000002",
            user: ALICE,
            text: "thread reply",
          },
        ],
      }),
    },
    users: {
      list: vi.fn().mockResolvedValue({ members: bolt.users }),
      info: vi.fn().mockImplementation(async ({ user }: { user: string }) => ({
        user: bolt.users.find((entry) => entry.id === user),
      })),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1.000001" }),
    },
    team: { info: vi.fn().mockResolvedValue({ team: { name: "Sandbox" } }) },
  };
}

const apps = vi.hoisted(() => [] as Array<ReturnType<typeof createAppRecord>>);

function createAppRecord() {
  const client = createClient();
  return {
    eventHandlers: new Map<
      string,
      (args: {
        event: unknown;
        client: unknown;
        body?: unknown;
      }) => Promise<void>
    >(),
    messageHandler: undefined as
      | ((args: {
          message: unknown;
          client: unknown;
          body?: unknown;
        }) => Promise<void>)
      | undefined,
    client,
  };
}

vi.mock("@slack/bolt", () => ({
  LogLevel: { INFO: "info" },
  App: class MockBoltApp {
    private readonly record = createAppRecord();
    client = this.record.client;

    constructor() {
      apps.push(this.record);
    }

    message(
      handler: (args: {
        message: unknown;
        client: unknown;
        body?: unknown;
      }) => Promise<void>,
    ) {
      this.record.messageHandler = handler;
    }

    event(
      name: string,
      handler: (args: {
        event: unknown;
        client: unknown;
        body?: unknown;
      }) => Promise<void>,
    ) {
      this.record.eventHandlers.set(name, handler);
    }

    async start() {}
    async stop() {}
  },
}));

import { SlackService } from "./service";

const OPS = "C0123ABCD";
const ALICE = "U0123ABCD";
const BOB = "U0999ZZZZ";

function memberEventBody(event: Record<string, unknown>) {
  return {
    team_id: "T0TEAM000",
    event_id: `Ev-${String(event.user)}-${String(event.channel)}-${String(event.event_ts ?? "")}`,
    event,
  };
}

function createRuntime(settings: Record<string, unknown>): IAgentRuntime {
  const projection = projectConnectorSettings({}, { slack: settings });
  const character = {
    name: "Slack Membership Test",
    settings: projection.settings,
    secrets: projection.secrets,
  };
  const secretEntries = Object.entries(projection.secrets) as Array<
    [string, string]
  >;
  const runtime = {
    agentId: "agent-slack-membership-integration",
    character,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn((key: string) => {
      const settings2 = character.settings as Record<string, unknown>;
      const secrets2 = character.secrets as Record<string, unknown>;
      if (Object.hasOwn(settings2, key)) return settings2[key];
      if (Object.hasOwn(secrets2, key)) return secrets2[key];
      const match = secretEntries.find(([k]) => k === key);
      return match ? match[1] : null;
    }),
    getWorld: vi.fn().mockResolvedValue(null),
    createWorld: vi.fn().mockResolvedValue(undefined),
    getRoom: vi.fn().mockResolvedValue(null),
    emitEvent: vi.fn().mockResolvedValue(undefined),
    createRoom: vi.fn().mockResolvedValue(undefined),
    createMemory: vi.fn().mockResolvedValue(undefined),
    getMemoryById: vi.fn().mockResolvedValue(null),
    createEntity: vi.fn().mockResolvedValue(undefined),
    getEntityById: vi.fn().mockResolvedValue(null),
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    removeParticipant: vi.fn().mockResolvedValue(true),
    reportError: vi.fn(),
  };
  return runtime as unknown as IAgentRuntime;
}

async function startHarness(overrides: Record<string, unknown> = {}) {
  const runtime = createRuntime({
    enabled: true,
    botToken: "xoxb-test-token",
    appToken: "xapp-test-token",
    groupPolicy: "allowlist",
    channels: { ops: { users: [ALICE] } },
    ...overrides,
  });
  bolt.channels.push({
    id: OPS,
    name: "ops",
    is_channel: true,
    is_member: true,
  });
  bolt.users.push(
    { id: ALICE, name: "alice", real_name: "Alice Example" },
    { id: BOB, name: "bob", real_name: "Bob Example" },
  );
  let service: InstanceType<typeof SlackService> | undefined;
  try {
    service = await SlackService.start(runtime);
  } catch (startError) {
    // error-policy:J2 context-adding rethrow: wrap with the captured log
    // tail and preserve the original start failure as cause.
    const calls = (runtime.logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .concat((runtime.logger.error as ReturnType<typeof vi.fn>).mock.calls)
      .map((c) => String(c.at(-1)));
    throw new Error(
      `SlackService.start failed: ${String(startError)}; logged: ${calls.join(" | ")}`,
      { cause: startError },
    );
  }
  if (apps.length === 0) {
    const calls = (
      runtime.logger.warn as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => String(c.at(-1)));
    throw new Error(
      `no app registered; start succeeded? logged: ${calls.join(" | ")}`,
    );
  }
  const app = apps.at(-1);
  if (!app)
    throw new Error(`Bolt app was not registered (apps=${apps.length})`);
  return { app, runtime, service };
}

describe("SlackService membership events", () => {
  beforeEach(() => {
    apps.length = 0;
    bolt.channels.length = 0;
    bolt.users.length = 0;
  });

  it("member_joined_channel payload preserves the Slack user and channel", async () => {
    const { app, runtime } = await startHarness();
    const handler = app.eventHandlers.get("member_joined_channel");
    expect(handler).toBeDefined();
    const event = {
      user: BOB,
      channel: OPS,
      channel_type: "C",
      event_ts: "1700000000.000200",
    };
    await handler?.({
      event,
      client: app.client,
      body: memberEventBody(event),
    });

    const [type, payload] = vi
      .mocked(runtime.emitEvent)
      .mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
    expect(type).toBe("SLACK_MEMBER_JOINED_CHANNEL");
    const slack = (payload.metadata as Record<string, unknown>).slack as Record<
      string,
      unknown
    >;
    expect(slack.userId).toBe(BOB);
    expect(slack.channelId).toBe(OPS);
    expect(slack.eventTs).toBe("1700000000.000200");
    expect(payload.entityId).toBeDefined();
  });

  it("member_left_channel payload preserves the Slack user and channel", async () => {
    const { app, runtime } = await startHarness();
    const handler = app.eventHandlers.get("member_left_channel");
    const event = { user: ALICE, channel: OPS, event_ts: "1700000000.000300" };
    await handler?.({
      event,
      client: app.client,
      body: memberEventBody(event),
    });
    const [type, payload] = vi
      .mocked(runtime.emitEvent)
      .mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
    expect(type).toBe("SLACK_MEMBER_LEFT_CHANNEL");
    const slack = (payload.metadata as Record<string, unknown>).slack as Record<
      string,
      unknown
    >;
    expect(slack.userId).toBe(ALICE);
    expect(slack.channelId).toBe(OPS);
  });

  it("a member join for an admitted channel renews runtime participation", async () => {
    const { app, runtime } = await startHarness();
    const handler = app.eventHandlers.get("member_joined_channel");
    const event = { user: ALICE, channel: OPS, event_ts: "1700000000.000400" };
    await handler?.({
      event,
      client: app.client,
      body: memberEventBody(event),
    });
    expect(runtime.ensureConnection).toHaveBeenCalled();
  });

  it("a member join for a non-admitted channel does not renew participation", async () => {
    const { app, runtime } = await startHarness();
    const handler = app.eventHandlers.get("member_joined_channel");
    const event = {
      user: ALICE,
      channel: "C0999ZZZZ",
      event_ts: "1700000000.000500",
    };
    await handler?.({
      event,
      client: app.client,
      body: memberEventBody(event),
    });
    expect(runtime.ensureConnection).not.toHaveBeenCalled();
  });

  it("a member leave removes only the room participant, not the entity", async () => {
    const { app, runtime } = await startHarness();
    const handler = app.eventHandlers.get("member_left_channel");
    const event = { user: ALICE, channel: OPS, event_ts: "1700000000.000600" };
    await handler?.({
      event,
      client: app.client,
      body: memberEventBody(event),
    });
    expect(runtime.removeParticipant).toHaveBeenCalledTimes(1);
    expect(runtime.createEntity).not.toHaveBeenCalled();
  });

  it("an inbound message from an existing sender renews room participation", async () => {
    // requireMention=false so the message path itself (not app_mention)
    // processes the message; the sender's entity already exists (e.g.
    // rejoined after leaving the room) — renewal must still run so
    // participation is re-linked.
    const { app, runtime } = await startHarness({
      channels: { ops: { users: [ALICE], requireMention: false } },
    });
    const handler = app.messageHandler;
    expect(handler).toBeDefined();
    (runtime.getEntityById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "existing",
      names: ["alice"],
    });
    await handler?.({
      message: {
        type: "message",
        user: ALICE,
        channel: OPS,
        text: "hello from alice",
        ts: "1700000000.000700",
      },
      client: app.client,
      body: memberEventBody({
        user: ALICE,
        channel: OPS,
        event_ts: "1700000000.000700",
      }),
    });
    expect(runtime.ensureConnection).toHaveBeenCalled();
  });

  it("an app mention from an existing sender renews room participation", async () => {
    const { app, runtime } = await startHarness();
    const handler = app.eventHandlers.get("app_mention");
    expect(handler).toBeDefined();
    (runtime.getEntityById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "existing",
      names: ["alice"],
    });
    await handler?.({
      event: {
        type: "app_mention",
        user: ALICE,
        channel: OPS,
        text: "<@U0BOTBOT0> hello",
        ts: "1700000000.000800",
      },
      client: app.client,
      body: memberEventBody({
        user: ALICE,
        channel: OPS,
        event_ts: "1700000000.000800",
      }),
    });
    expect(runtime.ensureConnection).toHaveBeenCalled();
  });
});

describe("SlackService membership snapshots", () => {
  beforeEach(() => {
    apps.length = 0;
    bolt.channels.length = 0;
    bolt.users.length = 0;
  });

  it("getChannelMembership returns unavailable for a non-admitted channel", async () => {
    const { service } = await startHarness();
    const result = await service.getChannelMembership("C0999ZZZZ");
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toBe("channel_not_admitted");
  });

  it("getChannelMembership pages conversations.members for an admitted channel", async () => {
    const { app, service } = await startHarness();
    const members = vi
      .fn()
      .mockResolvedValueOnce({
        members: [ALICE],
        response_metadata: { next_cursor: "c1" },
      })
      .mockResolvedValueOnce({ members: [BOB] });
    (app.client.conversations as { members: typeof members }).members = members;
    const result = await service.getChannelMembership(OPS);
    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    expect([...result.memberIds]).toEqual([ALICE, BOB]);
    expect(members).toHaveBeenCalledTimes(2);
  });

  it("getChannelMembership maps missing scope to unavailable, not empty", async () => {
    const { app, service } = await startHarness();
    // Real @slack/web-api platform-error shape: SDK class in `code`, Slack
    // error name in `data.error` (verified against
    // platformErrorFromResult in @slack/web-api/dist/errors.js).
    const scopeError = new Error(
      "An API error occurred: missing_scope",
    ) as unknown as {
      code: string;
      data: { error: string };
    };
    scopeError.code = "slack_webapi_platform_error";
    scopeError.data = { error: "missing_scope" };
    const members = vi.fn().mockRejectedValue(scopeError);
    (app.client.conversations as { members: typeof members }).members = members;
    const result = await service.getChannelMembership(OPS);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toBe("missing_scope");
    expect(result.slackErrorCode).toBe("missing_scope");
  });

  it("getChannelMembership maps a rate-limited error with the real SDK shape (no data)", async () => {
    const { app, service } = await startHarness();
    // @slack/web-api 7.15.2 rateLimitedErrorWithDelay sets only code +
    // retryAfter — there is no data property at all.
    const rateError = new Error("A rate-limit has been reached") as unknown as {
      code: string;
      retryAfter: number;
    };
    rateError.code = "slack_webapi_rate_limited_error";
    rateError.retryAfter = 30;
    const members = vi.fn().mockRejectedValue(rateError);
    (app.client.conversations as { members: typeof members }).members = members;
    const result = await service.getChannelMembership(OPS);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toBe("rate_limited");
    expect(result.slackErrorCode).toBe("ratelimited");
  });

  it("getChannelMembership treats a present-but-non-string cursor as malformed, not complete", async () => {
    const { app, service } = await startHarness();
    const members = vi
      .fn()
      .mockResolvedValueOnce({
        members: [ALICE],
        response_metadata: { next_cursor: 12345 },
      })
      .mockResolvedValueOnce({ members: [BOB] });
    (app.client.conversations as { members: typeof members }).members = members;
    const result = await service.getChannelMembership(OPS);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toBe("malformed_response");
    // The partial roster must never be reported as a snapshot.
    expect(members).toHaveBeenCalledTimes(1);
  });

  it("renewChannelMembership ensures connections for every snapshot member", async () => {
    const { app, runtime, service } = await startHarness();
    const members = vi.fn().mockResolvedValue({ members: [ALICE, BOB] });
    (app.client.conversations as { members: typeof members }).members = members;
    const result = await service.renewChannelMembership(OPS);
    expect(result.kind).toBe("snapshot");
    expect(runtime.ensureConnection).toHaveBeenCalledTimes(2);
  });

  it("membership evidence is scoped per account: entity/room ids differ across accounts", async () => {
    // Two accounts admit the same channel id; the derived runtime ids and
    // the clients used must be account-scoped, never shared.
    const { runtime, service } = await startHarness({
      accounts: {
        alpha: {
          botToken: "xoxb-alpha",
          appToken: "xapp-alpha",
          groupPolicy: "allowlist",
          channels: { ops: { users: [ALICE] } },
        },
        beta: {
          botToken: "xoxb-beta",
          appToken: "xapp-beta",
          groupPolicy: "allowlist",
          channels: { ops: { users: [ALICE] } },
        },
      },
    });
    expect(apps).toHaveLength(2);
    // Accounts start in sorted order: alpha first, beta second.
    const [alphaApp, betaApp] = apps;
    const alphaMembers = vi.fn().mockResolvedValue({ members: [ALICE] });
    const betaMembers = vi.fn().mockResolvedValue({ members: [ALICE] });
    (
      alphaApp.client.conversations as { members: typeof alphaMembers }
    ).members = alphaMembers;
    (betaApp.client.conversations as { members: typeof betaMembers }).members =
      betaMembers;

    const alphaResult = await service.renewChannelMembership(OPS, "alpha");
    const betaResult = await service.renewChannelMembership(OPS, "beta");
    expect(alphaResult.kind).toBe("snapshot");
    expect(betaResult.kind).toBe("snapshot");
    // Each renewal read its own account's client.
    expect(alphaMembers).toHaveBeenCalledTimes(1);
    expect(betaMembers).toHaveBeenCalledTimes(1);

    // Both accounts renewed the same Slack member in the same channel, so
    // the derivation — not the roster — must carry the account scope.
    const calls = (
      runtime.ensureConnection as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls).toHaveLength(2);
    const [alphaConnection, betaConnection] = calls;
    expect(String(alphaConnection.entityId)).not.toBe(
      String(betaConnection.entityId),
    );
    expect(String(alphaConnection.roomId)).not.toBe(
      String(betaConnection.roomId),
    );
    expect(String(alphaConnection.worldId)).not.toBe(
      String(betaConnection.worldId),
    );
    expect(alphaConnection.entityId).not.toBe("");
    expect(
      (alphaConnection.metadata as Record<string, unknown>).accountId,
    ).toBe("alpha");
    expect((betaConnection.metadata as Record<string, unknown>).accountId).toBe(
      "beta",
    );
  });
});

describe("thread inheritance in chat context", () => {
  beforeEach(() => {
    bolt.channels.length = 0;
    bolt.users.length = 0;
    apps.length = 0;
  });

  async function chatContextHarness(thread: Record<string, unknown>) {
    const { app, runtime, service } = await startHarness({ thread });
    bolt.channels.push({
      id: OPS,
      name: "ops",
      is_channel: true,
      is_member: true,
    });
    const context = {
      runtime,
      roomId: undefined,
    };
    const result = await service.getConnectorChatContext(
      { channelId: OPS, threadId: "1700000000.000000" },
      context as never,
    );
    return { app, runtime, service, result };
  }

  it("default reads only the thread transcript for thread targets", async () => {
    const { app, result } = await chatContextHarness({});
    expect(app.client.conversations.replies).toHaveBeenCalledTimes(1);
    expect(app.client.conversations.history).not.toHaveBeenCalled();
    // Slack returns replies earliest-first (parent first); the published
    // context must still be chronological oldest-first.
    expect(result?.recentMessages.map((m) => m.text)).toEqual([
      "thread parent",
      "thread reply",
    ]);
  });

  it("historyScope channel reads the parent channel transcript instead", async () => {
    const { app, result } = await chatContextHarness({
      historyScope: "channel",
    });
    expect(app.client.conversations.history).toHaveBeenCalledTimes(1);
    expect(app.client.conversations.replies).not.toHaveBeenCalled();
    expect(result?.recentMessages.map((m) => m.text)).toEqual([
      "thread parent",
      "channel message",
    ]);
  });

  it("inheritParent presents channel and thread transcripts chronologically", async () => {
    const { app, result } = await chatContextHarness({ inheritParent: true });
    expect(app.client.conversations.history).toHaveBeenCalledTimes(1);
    expect(app.client.conversations.replies).toHaveBeenCalledTimes(1);
    // The shared parent (ts .000000) appears in BOTH transcripts; it must
    // be published exactly once, then the later channel and thread items in
    // chronological order.
    expect(result?.recentMessages.map((m) => m.text)).toEqual([
      "thread parent",
      "channel message",
      "thread reply",
    ]);
  });

  it("historyScope channel takes precedence over inheritParent", async () => {
    const { app, result } = await chatContextHarness({
      historyScope: "channel",
      inheritParent: true,
    });
    expect(app.client.conversations.history).toHaveBeenCalledTimes(1);
    expect(app.client.conversations.replies).not.toHaveBeenCalled();
    expect(result?.recentMessages.map((m) => m.text)).toEqual([
      "thread parent",
      "channel message",
    ]);
  });
});

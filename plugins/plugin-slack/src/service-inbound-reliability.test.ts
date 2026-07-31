/**
 * Production-path proof for the inbound reliability core.
 *
 * Every test here drives the handlers that `registerEventHandlers` actually
 * binds to the bolt app — `app.message`, `app.event("app_mention")`,
 * `app.event("reaction_added")` and friends — captured off a fake `App`. The
 * assertion is always on `processAgentMessage` / `emitEvent`, i.e. whether a
 * real agent run happened. A helper-level test would prove nothing about
 * whether the guards are wired into the path Slack traffic takes.
 *
 * Bidirectional: each block states what unfixed develop does. On develop these
 * fail (duplicate agent runs on redelivery, dropped turns in the twin race,
 * accepted cross-workspace events); with this change they pass.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "./accounts";
import { SlackInboundReliability } from "./inbound-reliability";
import { SlackLivenessTracker } from "./reconnect-policy";
import { SlackService } from "./service";
import type { SlackChannel, SlackSettings, SlackUser } from "./types";

const BOT_USER_ID = "U0BOTBOT0";
const CHANNEL_ID = "C0123ABCD";
const USER_ID = "U0123ABCD";
const TEAM_ID = "T0TEAM000";
const API_APP_ID = "A0APP0000";

function createRuntime() {
  return {
    agentId: "agent-slack-reliability",
    character: { name: "Salem", settings: {} },
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn().mockReturnValue(undefined),
    emitEvent: vi.fn().mockResolvedValue(undefined),
    createMemory: vi.fn().mockResolvedValue(undefined),
    createEntity: vi.fn().mockResolvedValue(undefined),
    getEntityById: vi.fn().mockResolvedValue({ id: "entity-1" }),
  } as unknown as IAgentRuntime;
}

interface HarnessOptions {
  mentionGraceMs?: number;
  /** Lets a test make the mention path bail or throw. */
  mentionBehaviour?: "ok" | "skip" | "throw";
  messageBehaviour?: "ok" | "throw";
  identity?: {
    apiAppId?: string | null;
    teamId?: string | null;
    enterpriseId?: string | null;
  };
}

/**
 * Builds a SlackService with one account state wired the way
 * `initializeAccount` wires it, then returns the handlers that
 * `registerEventHandlers` binds to the bolt app.
 */
function createHarness(options: HarnessOptions = {}) {
  const runtime = createRuntime();
  const service = Object.create(SlackService.prototype) as SlackService;

  const settings: SlackSettings = {
    shouldIgnoreBotMessages: true,
    shouldRespondOnlyToMentions: false,
  };

  const account = {
    accountId: "default",
    enabled: true,
    role: "AGENT",
    botToken: "xoxb-test",
    appToken: "xapp-test",
    config: {},
  } as unknown as ResolvedSlackAccount;

  const state = {
    accountId: "default",
    account,
    app: {} as never,
    client: {} as never,
    userClient: null,
    botUserId: BOT_USER_ID,
    teamId: TEAM_ID,
    settings,
    allowedChannelIds: new Set<string>(),
    dynamicChannelIds: new Set<string>(),
    userCache: new Map<string, SlackUser>(),
    channelCache: new Map<string, SlackChannel>(),
    isConnected: true,
    identity: options.identity ?? {
      apiAppId: API_APP_ID,
      teamId: TEAM_ID,
      enterpriseId: null,
    },
    reliability: new SlackInboundReliability({
      mentionGraceMs: options.mentionGraceMs ?? 20,
    }),
    liveness: new SlackLivenessTracker(),
  };

  Object.assign(service, {
    runtime,
    character: runtime.character,
    settings,
    defaultAccountId: "default",
    accountStates: new Map([["default", state]]),
    accountStarts: new Map(),
    allowedChannelIds: new Set<string>(),
    dynamicChannelIds: new Set<string>(),
    userCache: new Map(),
    channelCache: new Map(),
    botUserId: BOT_USER_ID,
    teamId: TEAM_ID,
    isConnected: true,
  });

  // Everything downstream of the guards is stubbed: the assertion is purely
  // "did a real agent run happen, and how many times".
  const processAgentMessage = vi.fn().mockResolvedValue(undefined);

  const mentionBehaviour = options.mentionBehaviour ?? "ok";
  const messageBehaviour = options.messageBehaviour ?? "ok";

  Object.assign(service, {
    processAgentMessage,
    // `isChannelAllowed` is the gating lane's surface; keep it permissive here
    // so this file only exercises reliability.
    isChannelAllowed: () => true,
    buildMemoryFromMessage: vi.fn().mockImplementation(async () => {
      if (messageBehaviour === "throw") {
        throw new Error("message path exploded");
      }
      return { id: "mem-msg", entityId: "entity-1" };
    }),
    buildMemoryFromMention: vi.fn().mockImplementation(async () => {
      if (mentionBehaviour === "throw") {
        throw new Error("mention path exploded");
      }
      // `null` is the real "mention bailed" signal in handleAppMention.
      return mentionBehaviour === "skip"
        ? null
        : { id: "mem-mention", entityId: "entity-1" };
    }),
    ensureRoomExists: vi.fn().mockResolvedValue({ id: "room-1" }),
    getUser: vi.fn().mockResolvedValue(null),
  });

  const handlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<void>
  > = {};

  const app = {
    message: (fn: (args: Record<string, unknown>) => Promise<void>) => {
      handlers.message = fn;
    },
    event: (
      name: string,
      fn: (args: Record<string, unknown>) => Promise<void>,
    ) => {
      handlers[name] = fn;
    },
  };

  (
    service as unknown as { registerEventHandlers: (s: unknown) => void }
  ).registerEventHandlers({ ...state, app });

  return { service, runtime, handlers, processAgentMessage, state };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    api_app_id: API_APP_ID,
    team_id: TEAM_ID,
    type: "event_callback",
    event_id: "Ev0000000",
    event_time: 1_709_000_000,
    ...overrides,
  };
}

function plainMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    channel: CHANNEL_ID,
    channel_type: "channel",
    user: USER_ID,
    text: "chores status?",
    ts: "1709000000.000100",
    ...overrides,
  };
}

function mentionMessage(overrides: Record<string, unknown> = {}) {
  return plainMessage({
    text: `<@${BOT_USER_ID}> chores status?`,
    ...overrides,
  });
}

function mentionEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "app_mention",
    channel: CHANNEL_ID,
    user: USER_ID,
    text: `<@${BOT_USER_ID}> chores status?`,
    ts: "1709000000.000100",
    event_ts: "1709000000.000100",
    ...overrides,
  };
}

describe("registration", () => {
  it("binds every inbound family on the real bolt app", () => {
    const { handlers } = createHarness();
    for (const name of [
      "message",
      "app_mention",
      "reaction_added",
      "reaction_removed",
      "member_joined_channel",
      "member_left_channel",
      "file_shared",
    ]) {
      expect(handlers[name], `handler ${name}`).toBeTypeOf("function");
    }
  });
});

describe("capability 1 — event dedupe on Slack redelivery", () => {
  it("runs the agent once when Slack redelivers the same message event", async () => {
    // FAILS on unfixed develop: no dedupe cache exists, so a redelivered
    // event (identical event_id, retry_num 1) produces a second agent run and
    // a duplicate reply.
    const { handlers, processAgentMessage } = createHarness();

    const body = envelope({ event_id: "Ev_RETRY_1" });
    await handlers.message?.({
      message: plainMessage(),
      client: {},
      body,
      context: {},
    });
    await handlers.message?.({
      message: plainMessage(),
      client: {},
      body: { ...body, retry_num: 1 },
      context: { retryNum: 1 },
    });

    expect(processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("runs the agent once when the same app_mention is redelivered", async () => {
    const { handlers, processAgentMessage } = createHarness();

    const body = envelope({ event_id: "Ev_RETRY_2" });
    await handlers.app_mention?.({
      event: mentionEvent(),
      client: {},
      body,
      context: {},
    });
    await handlers.app_mention?.({
      event: mentionEvent(),
      client: {},
      body: { ...body, retry_num: 2 },
      context: { retryNum: 2 },
    });

    expect(processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("still processes two genuinely distinct messages in one channel", async () => {
    // Guards against over-deduping: top-level messages are scoped by their own
    // ts, so a busy channel does not collapse into one lane.
    const { handlers, processAgentMessage } = createHarness();

    await handlers.message?.({
      message: plainMessage({ ts: "1709000000.000100" }),
      client: {},
      body: envelope({ event_id: "Ev_A" }),
      context: {},
    });
    await handlers.message?.({
      message: plainMessage({ ts: "1709000000.000200", text: "and dishes?" }),
      client: {},
      body: envelope({ event_id: "Ev_B" }),
      context: {},
    });

    expect(processAgentMessage).toHaveBeenCalledTimes(2);
  });

  it("dedupes redelivered non-message events by event_id", async () => {
    // FAILS on unfixed develop: reaction redelivery emits the event twice.
    const { handlers, runtime } = createHarness();
    const body = envelope({ event_id: "Ev_REACTION" });
    const event = {
      user: USER_ID,
      reaction: "white_check_mark",
      item: { type: "message", channel: CHANNEL_ID, ts: "1709000000.000100" },
    };

    await handlers.reaction_added?.({ event, body });
    await handlers.reaction_added?.({ event, body: { ...body, retry_num: 1 } });

    const emitted = (runtime.emitEvent as ReturnType<typeof vi.fn>).mock.calls;
    expect(emitted).toHaveLength(1);
  });
});

describe("capability 2 — app_mention / message race", () => {
  it("runs the agent exactly once when the mention wins", async () => {
    const { handlers, processAgentMessage } = createHarness();

    await handlers.app_mention?.({
      event: mentionEvent(),
      client: {},
      body: envelope({ event_id: "Ev_M1" }),
      context: {},
    });
    await handlers.message?.({
      message: mentionMessage(),
      client: {},
      body: envelope({ event_id: "Ev_M2" }),
      context: {},
    });

    expect(processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("runs the agent exactly once when the message twin arrives first", async () => {
    const { handlers, processAgentMessage } = createHarness();

    const messageRun = handlers.message?.({
      message: mentionMessage(),
      client: {},
      body: envelope({ event_id: "Ev_M3" }),
      context: {},
    });
    await Promise.resolve();
    const mentionRun = handlers.app_mention?.({
      event: mentionEvent(),
      client: {},
      body: envelope({ event_id: "Ev_M4" }),
      context: {},
    });

    await Promise.all([messageRun, mentionRun]);

    expect(processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("does not drop the turn when the mention path bails", async () => {
    // FAILS on unfixed develop: handleMessage returns unconditionally for a
    // channel mention, so when handleAppMention bails (here: no memory built)
    // NOTHING answers the user. This is the silent-drop half of the bug.
    const { handlers, processAgentMessage } = createHarness({
      mentionBehaviour: "skip",
    });

    const messageRun = handlers.message?.({
      message: mentionMessage(),
      client: {},
      body: envelope({ event_id: "Ev_M5" }),
      context: {},
    });
    await Promise.resolve();
    await handlers.app_mention?.({
      event: mentionEvent(),
      client: {},
      body: envelope({ event_id: "Ev_M6" }),
      context: {},
    });
    await messageRun;

    expect(processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("does not drop the turn when the mention path throws", async () => {
    const { handlers, processAgentMessage } = createHarness({
      mentionBehaviour: "throw",
    });

    const messageRun = handlers.message?.({
      message: mentionMessage(),
      client: {},
      body: envelope({ event_id: "Ev_M7" }),
      context: {},
    });
    await Promise.resolve();
    await expect(
      handlers.app_mention?.({
        event: mentionEvent(),
        client: {},
        body: envelope({ event_id: "Ev_M8" }),
        context: {},
      }),
    ).rejects.toThrow("mention path exploded");
    await messageRun;

    expect(processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("answers a mention whose app_mention twin never arrives", async () => {
    // FAILS on unfixed develop: the message is discarded outright and the
    // user is never answered.
    const { handlers, processAgentMessage } = createHarness({
      mentionGraceMs: 5,
    });

    await handlers.message?.({
      message: mentionMessage(),
      client: {},
      body: envelope({ event_id: "Ev_M9" }),
      context: {},
    });

    expect(processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("handles both twins arriving concurrently without dropping or doubling", async () => {
    const { handlers, processAgentMessage } = createHarness();

    await Promise.all([
      handlers.message?.({
        message: mentionMessage(),
        client: {},
        body: envelope({ event_id: "Ev_C1" }),
        context: {},
      }),
      handlers.app_mention?.({
        event: mentionEvent(),
        client: {},
        body: envelope({ event_id: "Ev_C2" }),
        context: {},
      }),
    ]);

    expect(processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("still answers DM mentions, which have no app_mention twin", async () => {
    const { handlers, processAgentMessage } = createHarness();

    await handlers.message?.({
      message: mentionMessage({ channel: "D0123ABCD", channel_type: "im" }),
      client: {},
      body: envelope({ event_id: "Ev_DM" }),
      context: {},
    });

    expect(processAgentMessage).toHaveBeenCalledTimes(1);
  });
});

describe("capability 3 — multi-workspace event isolation", () => {
  it("drops a message event from a foreign team_id", async () => {
    // FAILS on unfixed develop: events are attributed by handler closure only,
    // so a foreign workspace's message is processed into this account.
    const { handlers, processAgentMessage } = createHarness();

    await handlers.message?.({
      message: plainMessage(),
      client: {},
      body: envelope({ team_id: "T_OTHER", event_id: "Ev_X1" }),
      context: {},
    });

    expect(processAgentMessage).not.toHaveBeenCalled();
  });

  it("drops a message event from a foreign api_app_id", async () => {
    const { handlers, processAgentMessage } = createHarness();

    await handlers.message?.({
      message: plainMessage(),
      client: {},
      body: envelope({ api_app_id: "A_OTHER", event_id: "Ev_X2" }),
      context: {},
    });

    expect(processAgentMessage).not.toHaveBeenCalled();
  });

  it("drops a foreign app_mention", async () => {
    const { handlers, processAgentMessage } = createHarness();

    await handlers.app_mention?.({
      event: mentionEvent(),
      client: {},
      body: envelope({ team_id: "T_OTHER", event_id: "Ev_X3" }),
      context: {},
    });

    expect(processAgentMessage).not.toHaveBeenCalled();
  });

  it("drops foreign events on every non-message family too", async () => {
    // Defense in depth is only defense if it is uniform: a foreign reaction or
    // member-join corrupts state just as effectively as a message.
    const { handlers, runtime } = createHarness();
    const foreign = envelope({ team_id: "T_OTHER", event_id: "Ev_X4" });

    await handlers.reaction_added?.({
      event: {
        user: USER_ID,
        reaction: "eyes",
        item: { type: "message", channel: CHANNEL_ID, ts: "1.1" },
      },
      body: foreign,
    });
    await handlers.reaction_removed?.({
      event: {
        user: USER_ID,
        reaction: "eyes",
        item: { type: "message", channel: CHANNEL_ID, ts: "1.1" },
      },
      body: foreign,
    });
    await handlers.member_joined_channel?.({
      event: { user: USER_ID, channel: CHANNEL_ID },
      body: foreign,
    });
    await handlers.member_left_channel?.({
      event: { user: USER_ID, channel: CHANNEL_ID },
      body: foreign,
    });
    await handlers.file_shared?.({
      event: { file_id: "F1", user_id: USER_ID, channel_id: CHANNEL_ID },
      body: foreign,
    });

    expect(runtime.emitEvent).not.toHaveBeenCalled();
  });

  it("does not drop a foreign member_joined_channel into dynamic channels", async () => {
    // The concrete cross-tenant state corruption: without the guard, a foreign
    // bot-join would widen THIS account's allowlist.
    const { handlers, state } = createHarness();

    await handlers.member_joined_channel?.({
      event: { user: BOT_USER_ID, channel: "C_FOREIGN" },
      body: envelope({ team_id: "T_OTHER", event_id: "Ev_X5" }),
    });

    expect(state.dynamicChannelIds.has("C_FOREIGN")).toBe(false);
  });

  it("accepts matching events, so isolation is not just a blanket deny", async () => {
    const { handlers, processAgentMessage } = createHarness();

    await handlers.message?.({
      message: plainMessage(),
      client: {},
      body: envelope({ event_id: "Ev_OK" }),
      context: {},
    });

    expect(processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("accepts events whose envelope omits the identity fields", async () => {
    // Fail-open on ABSENT fields: some families carry no team_id, and dropping
    // those would break working deployments to defend against nothing.
    const { handlers, processAgentMessage } = createHarness();

    await handlers.message?.({
      message: plainMessage(),
      client: {},
      body: { type: "event_callback", event_id: "Ev_BARE" },
      context: {},
    });

    expect(processAgentMessage).toHaveBeenCalledTimes(1);
  });
});

describe("capability 4 — liveness tracking on the real path", () => {
  it("records lastEventAt only once inbound traffic actually arrives", async () => {
    const { handlers, service } = createHarness();

    const before = (
      service as unknown as {
        getHealth: () => Record<string, { lastEventAt: number | null }>;
      }
    ).getHealth();
    expect(before.default.lastEventAt).toBeNull();

    await handlers.message?.({
      message: plainMessage(),
      client: {},
      body: envelope({ event_id: "Ev_LIVE" }),
      context: {},
    });

    const after = (
      service as unknown as {
        getHealth: () => Record<string, { lastEventAt: number | null }>;
      }
    ).getHealth();
    expect(after.default.lastEventAt).toBeTypeOf("number");
  });

  it("counts a gated-out event as liveness, since the socket did deliver it", async () => {
    const { handlers, service } = createHarness();

    await handlers.message?.({
      message: plainMessage({ user: BOT_USER_ID }),
      client: {},
      body: envelope({ event_id: "Ev_SELF" }),
      context: {},
    });

    const health = (
      service as unknown as {
        getHealth: () => Record<string, { lastEventAt: number | null }>;
      }
    ).getHealth();
    expect(health.default.lastEventAt).toBeTypeOf("number");
  });
});

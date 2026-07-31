/**
 * Inbound gating tests for `SlackService` — the production-path proof for
 * per-channel `channels.slack.channels[<id>]` config.
 *
 * These drive the REAL handlers registered on the bolt app in
 * `registerEventHandlers` (`app.message` → `handleMessage`, `app.event
 * ("app_mention")` → `handleAppMention`), not a helper, and assert on whether
 * `processAgentMessage` ran. On unfixed develop the per-channel config is
 * parsed and discarded, so the requireMention/users/enabled cases below fail;
 * with the resolver wired in they pass.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount, SlackChannelConfig } from "./accounts";
import { SlackService } from "./service";
import type { SlackChannel, SlackSettings, SlackUser } from "./types";

const BOT_USER_ID = "U0BOTBOT0";
const CHANNEL_ID = "C0123ABCD";
const OTHER_CHANNEL_ID = "C0999ZZZZ";
const USER_ID = "U0123ABCD";
const OTHER_USER_ID = "U0OTHER99";

function createRuntime() {
  return {
    agentId: "agent-slack-gating",
    character: { name: "Salem", settings: {} },
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn().mockReturnValue(undefined),
    emitEvent: vi.fn(),
    createMemory: vi.fn(),
    createEntity: vi.fn(),
    getEntityById: vi.fn().mockResolvedValue({ id: "entity-1" }),
  } as unknown as IAgentRuntime;
}

interface HarnessOptions {
  channels?: Record<string, SlackChannelConfig>;
  allowedChannelIds?: string[];
  globalRequireMention?: boolean;
  accountRequireMention?: boolean;
  dynamicChannelIds?: string[];
  channelCache?: Map<string, SlackChannel>;
}

/**
 * Builds a SlackService with one account state wired the way
 * `startAccount` wires it, then returns the handlers that
 * `registerEventHandlers` actually binds to the bolt app.
 */
function createHarness(options: HarnessOptions = {}) {
  const runtime = createRuntime();
  const service = Object.create(SlackService.prototype) as SlackService;

  const settings: SlackSettings = {
    allowedChannelIds: options.allowedChannelIds,
    shouldIgnoreBotMessages: true,
    shouldRespondOnlyToMentions: options.globalRequireMention ?? false,
  };

  const account = {
    accountId: "default",
    enabled: true,
    role: "AGENT",
    botToken: "xoxb-test",
    appToken: "xapp-test",
    botTokenSource: "config",
    appTokenSource: "config",
    config: {},
    channels: options.channels ?? {},
    requireMention: options.accountRequireMention,
  } as unknown as ResolvedSlackAccount;

  const allowedChannelIds = new Set<string>(options.allowedChannelIds ?? []);
  // Mirror buildAllowedChannelSet: id-keyed structured entries are an
  // allowlist source alongside SLACK_CHANNEL_IDS.
  for (const [key, entry] of Object.entries(options.channels ?? {})) {
    if (!entry) continue;
    if (entry.enabled === false || entry.allow === false) continue;
    if (/^[CGD][A-Z0-9]{8,}$/i.test(key)) allowedChannelIds.add(key);
  }

  const state = {
    accountId: "default",
    account,
    app: {} as never,
    client: {} as never,
    userClient: null,
    botUserId: BOT_USER_ID,
    teamId: "T0TEAM000",
    settings,
    allowedChannelIds,
    dynamicChannelIds: new Set<string>(options.dynamicChannelIds ?? []),
    channelConfigs: options.channels ?? {},
    userCache: new Map<string, SlackUser>(),
    channelCache: options.channelCache ?? new Map<string, SlackChannel>(),
    isConnected: true,
  };

  Object.assign(service, {
    runtime,
    character: runtime.character,
    settings,
    defaultAccountId: "default",
    accountStates: new Map([["default", state]]),
    accountStarts: new Map(),
    allowedChannelIds,
    dynamicChannelIds: new Set<string>(),
    userCache: new Map(),
    channelCache: new Map(),
    botUserId: BOT_USER_ID,
    teamId: "T0TEAM000",
    isConnected: true,
  });

  // Everything downstream of the gate is stubbed: the assertion is purely
  // "did the message get past gating".
  const processAgentMessage = vi.fn().mockResolvedValue(undefined);
  Object.assign(service, {
    processAgentMessage,
    buildMemoryFromMessage: vi.fn().mockResolvedValue({ id: "mem-1" }),
    buildMemoryFromMention: vi.fn().mockResolvedValue({ id: "mem-1" }),
    ensureRoomExists: vi.fn().mockResolvedValue({ id: "room-1" }),
    getUser: vi.fn().mockResolvedValue(null),
  });

  // Capture the handlers the service registers on the bolt app — this is the
  // production wiring, so the tests cannot drift onto a dead helper.
  const handlers: {
    message?: (args: { message: unknown; client: unknown }) => Promise<void>;
    appMention?: (args: { event: unknown; client: unknown }) => Promise<void>;
  } = {};

  const app = {
    message: (
      fn: (args: { message: unknown; client: unknown }) => Promise<void>,
    ) => {
      handlers.message = fn;
    },
    event: (
      name: string,
      fn: (args: { event: unknown; client: unknown }) => Promise<void>,
    ) => {
      if (name === "app_mention") handlers.appMention = fn;
    },
  };

  (
    service as unknown as {
      registerEventHandlers: (s: unknown) => void;
    }
  ).registerEventHandlers({ ...state, app });

  return { service, runtime, handlers, processAgentMessage };
}

function channelMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    channel: CHANNEL_ID,
    channel_type: "channel",
    user: USER_ID,
    text: "chores status?",
    ts: "1700000000.000100",
    ...overrides,
  };
}

describe("SlackService inbound gating — per-channel requireMention", () => {
  let harness: ReturnType<typeof createHarness>;

  it("registers handlers on the real bolt message and app_mention events", () => {
    harness = createHarness();
    expect(harness.handlers.message).toBeTypeOf("function");
    expect(harness.handlers.appMention).toBeTypeOf("function");
  });

  it("drops an unmentioned message when the channel sets requireMention:true", async () => {
    // FAILS on unfixed develop: channels[].requireMention is ignored, so the
    // message is processed.
    harness = createHarness({
      channels: { [CHANNEL_ID]: { requireMention: true } },
    });

    await harness.handlers.message?.({
      message: channelMessage(),
      client: {},
    });

    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("processes an unmentioned message when the channel sets requireMention:false", async () => {
    harness = createHarness({
      channels: { [CHANNEL_ID]: { requireMention: false } },
    });

    await harness.handlers.message?.({
      message: channelMessage(),
      client: {},
    });

    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("lets a per-channel requireMention:false override the global mention-only flag", async () => {
    // FAILS on unfixed develop: only the global flag is consulted, so the
    // message is dropped.
    harness = createHarness({
      globalRequireMention: true,
      channels: { [CHANNEL_ID]: { requireMention: false } },
    });

    await harness.handlers.message?.({
      message: channelMessage(),
      client: {},
    });

    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("lets a per-channel requireMention:true override a permissive global default", async () => {
    // FAILS on unfixed develop: with the global flag unset every message is
    // processed regardless of per-channel config.
    harness = createHarness({
      globalRequireMention: false,
      channels: {
        [CHANNEL_ID]: { requireMention: true },
        [OTHER_CHANNEL_ID]: { requireMention: false },
      },
    });

    await harness.handlers.message?.({
      message: channelMessage(),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();

    // The sibling channel opted out, so it still replies unmentioned.
    await harness.handlers.message?.({
      message: channelMessage({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("honours the account-level requireMention when the channel is silent", async () => {
    harness = createHarness({
      accountRequireMention: true,
      channels: { [CHANNEL_ID]: {} },
    });

    await harness.handlers.message?.({
      message: channelMessage(),
      client: {},
    });

    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("still honours the global env flag when no structured config exists", async () => {
    harness = createHarness({ globalRequireMention: true });

    await harness.handlers.message?.({
      message: channelMessage(),
      client: {},
    });

    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("resolves requireMention through a name-keyed entry using the channel cache", async () => {
    const channelCache = new Map<string, SlackChannel>([
      [CHANNEL_ID, { id: CHANNEL_ID, name: "house-chores" } as SlackChannel],
    ]);
    harness = createHarness({
      allowedChannelIds: [CHANNEL_ID],
      channels: { "house-chores": { requireMention: true } },
      channelCache,
    });

    await harness.handlers.message?.({
      message: channelMessage(),
      client: {},
    });

    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("applies the wildcard entry to an otherwise unconfigured channel", async () => {
    harness = createHarness({
      allowedChannelIds: [CHANNEL_ID],
      channels: { "*": { requireMention: true } },
    });

    await harness.handlers.message?.({
      message: channelMessage(),
      client: {},
    });

    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });
});

describe("SlackService inbound gating — structured channels as an allowlist source", () => {
  it("admits a channel that only the structured config names", async () => {
    // FAILS on unfixed develop: with SLACK_CHANNEL_IDS unset the allowlist is
    // empty, so EVERY channel is admitted — including the one the operator
    // never listed. Asserting the unlisted channel is dropped is the proof.
    const harness = createHarness({
      channels: { [CHANNEL_ID]: { requireMention: false } },
    });

    await harness.handlers.message?.({
      message: channelMessage(),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a channel absent from the structured allowlist", async () => {
    // FAILS on unfixed develop (empty allowlist ⇒ all channels allowed).
    const harness = createHarness({
      channels: { [CHANNEL_ID]: { requireMention: false } },
    });

    await harness.handlers.message?.({
      message: channelMessage({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });

    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("drops an explicitly disabled channel even when it was dynamically joined", async () => {
    // FAILS on unfixed develop: `enabled: false` is ignored and a dynamic join
    // admits the channel unconditionally.
    const harness = createHarness({
      channels: { [CHANNEL_ID]: { enabled: false } },
      dynamicChannelIds: [CHANNEL_ID],
    });

    await harness.handlers.message?.({
      message: channelMessage(),
      client: {},
    });

    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("keeps replying everywhere when nothing is configured at all", async () => {
    const harness = createHarness();

    await harness.handlers.message?.({
      message: channelMessage({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });

    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });
});

describe("SlackService inbound gating — per-channel user allowlist", () => {
  it("drops a message from a user outside the channel users list", async () => {
    // FAILS on unfixed develop: channels[].users is ignored entirely.
    const harness = createHarness({
      channels: {
        [CHANNEL_ID]: { requireMention: false, users: [USER_ID] },
      },
    });

    await harness.handlers.message?.({
      message: channelMessage({ user: OTHER_USER_ID }),
      client: {},
    });

    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("processes a message from a user inside the channel users list", async () => {
    const harness = createHarness({
      channels: {
        [CHANNEL_ID]: { requireMention: false, users: [USER_ID] },
      },
    });

    await harness.handlers.message?.({
      message: channelMessage({ user: USER_ID }),
      client: {},
    });

    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });
});

describe("SlackService inbound gating — app_mention path", () => {
  function mentionEvent(overrides: Record<string, unknown> = {}) {
    return {
      type: "app_mention",
      channel: CHANNEL_ID,
      user: USER_ID,
      text: `<@${BOT_USER_ID}> status?`,
      ts: "1700000000.000200",
      event_ts: "1700000000.000200",
      ...overrides,
    };
  }

  it("still answers an @mention in a channel that requires mentions", async () => {
    const harness = createHarness({
      channels: { [CHANNEL_ID]: { requireMention: true } },
    });

    await harness.handlers.appMention?.({
      event: mentionEvent(),
      client: {},
    });

    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("drops an @mention in an explicitly disabled channel", async () => {
    // FAILS on unfixed develop: handleAppMention had NO gating at all, so a
    // disabled channel stayed reachable by @-mentioning the bot.
    const harness = createHarness({
      channels: { [CHANNEL_ID]: { enabled: false } },
      dynamicChannelIds: [CHANNEL_ID],
    });

    await harness.handlers.appMention?.({
      event: mentionEvent(),
      client: {},
    });

    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("drops an @mention from a user outside the channel users list", async () => {
    // FAILS on unfixed develop (no user gating on the mention path).
    const harness = createHarness({
      channels: { [CHANNEL_ID]: { users: [USER_ID] } },
    });

    await harness.handlers.appMention?.({
      event: mentionEvent({ user: OTHER_USER_ID }),
      client: {},
    });

    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("drops an @mention in a channel outside the structured allowlist", async () => {
    // FAILS on unfixed develop (mention path bypassed isChannelAllowed).
    const harness = createHarness({
      channels: { [CHANNEL_ID]: {} },
    });

    await harness.handlers.appMention?.({
      event: mentionEvent({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });

    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });
});

describe("SlackService inbound gating — DM behaviour is unchanged in this slice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes a DM even when a wildcard channel entry requires mentions", async () => {
    const harness = createHarness({
      channels: { "*": { requireMention: true } },
    });

    await harness.handlers.message?.({
      message: channelMessage({
        channel: "D0123ABCD",
        channel_type: "im",
        text: "hey",
      }),
      client: {},
    });

    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });
});

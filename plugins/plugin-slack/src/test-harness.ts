/**
 * Shared PRODUCTION-PATH test harness for the Slack inbound gate.
 *
 * Every gating test in this package boots through this helper, and the helper
 * deliberately offers no way to inject a hand-built `ResolvedSlackAccount`.
 * The reviewed head's tests constructed one directly, which bypassed BOTH
 * broken upstream paths (character projection and account resolution) and let
 * a gate that received no configuration at all pass its own suite.
 *
 * The chain exercised here is the real one:
 *
 *   persisted ElizaConfig
 *     -> buildCharacterFromConfig()          (real character projection)
 *     -> character.settings.slack
 *     -> resolveSlackAccount()               (real account resolution)
 *     -> resolveSlackAccountPolicy()         (real startup policy resolution)
 *     -> registerEventHandlers()             (real Bolt handler registration)
 *     -> the captured app.message / app.event callbacks
 *
 * Only what is strictly DOWNSTREAM of the gate is stubbed, so an assertion on
 * `processAgentMessage` is an assertion about admission and nothing else.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { type Mock, vi } from "vitest";
import type { ElizaConfig } from "../../../packages/agent/src/config/config.ts";
import { buildCharacterFromConfig } from "../../../packages/agent/src/runtime/build-character-config.ts";
import type { ResolvedSlackAccount } from "./accounts";
import { resolveSlackAccount } from "./accounts";
import {
  resolveSlackAccountPolicy,
  type SlackPolicyLookups,
  type SlackResolvedPolicy,
} from "./policy";
import { SlackService } from "./service";
import type { SlackChannel, SlackUser } from "./types";

/** Handlers captured from the real `registerEventHandlers` registration. */
export interface CapturedSlackHandlers {
  message?: (args: { message: unknown; client: unknown }) => Promise<void>;
  appMention?: (args: { event: unknown; client: unknown }) => Promise<void>;
  memberJoined?: (args: { event: unknown }) => Promise<void>;
}

/**
 * Explicitly annotated so the inferred type never leaks a `@vitest/spy`
 * internal into the package's declaration output (TS2883).
 */
export interface SlackHarness {
  service: SlackService;
  runtime: IAgentRuntime;
  account: ResolvedSlackAccount;
  policy: SlackResolvedPolicy;
  handlers: CapturedSlackHandlers;
  processAgentMessage: Mock;
}

export const BOT_USER_ID = "U0BOTBOT0";
export const CHANNEL_ID = "C0123ABCD";
export const OTHER_CHANNEL_ID = "C0999ZZZZ";
export const DM_CHANNEL_ID = "D0123ABCD";
export const MPIM_CHANNEL_ID = "G0MPIM0000";
export const USER_ID = "U0123ABCD";
export const OTHER_USER_ID = "U0OTHER99";

/** Slack lookups backed by a fixed fake workspace. */
export function fakeLookups(
  overrides: {
    channels?: Array<{ id: string; name?: string }>;
    users?: Array<{
      id: string;
      name?: string;
      realName?: string;
      displayName?: string;
      deleted?: boolean;
    }>;
    failChannels?: boolean;
    failUsers?: boolean;
  } = {},
): SlackPolicyLookups {
  return {
    listChannels: async () => {
      if (overrides.failChannels) throw new Error("missing_scope");
      return (
        overrides.channels ?? [
          { id: CHANNEL_ID, name: "general" },
          { id: OTHER_CHANNEL_ID, name: "random" },
        ]
      );
    },
    listUsers: async () => {
      if (overrides.failUsers) throw new Error("missing_scope");
      return (
        overrides.users ?? [
          { id: USER_ID, name: "salem", realName: "Salem Agent" },
          { id: OTHER_USER_ID, name: "intruder", realName: "Some Intruder" },
        ]
      );
    },
  };
}

/** A production-shaped config: the exact shape the docs tell operators to write. */
export function persistedSlackConfig(
  slack: Record<string, unknown>,
): ElizaConfig {
  return {
    agents: { list: [{ name: "Salem", system: "house agent" }] },
    connectors: {
      slack: {
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        ...slack,
      },
    },
  } as unknown as ElizaConfig;
}

export interface RuntimeOptions {
  /** Values the plugin reads via `runtime.getSetting` (env-var lane). */
  settings?: Record<string, string | undefined>;
}

/** Builds a runtime from a REAL persisted config, through REAL projection. */
export function runtimeFromPersistedConfig(
  config: ElizaConfig,
  options: RuntimeOptions = {},
): IAgentRuntime {
  const character = buildCharacterFromConfig(config);
  const settings = options.settings ?? {};
  return {
    agentId: "agent-slack-policy",
    character,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn((key: string) => settings[key]),
    emitEvent: vi.fn(),
    createMemory: vi.fn(),
    createEntity: vi.fn(),
    getEntityById: vi.fn().mockResolvedValue({ id: "entity-1" }),
  } as unknown as IAgentRuntime;
}

export interface BootOptions extends RuntimeOptions {
  lookups?: SlackPolicyLookups;
  accountId?: string;
  envAllowedChannelIds?: string[];
  globalRequireMention?: boolean;
  ignoreBotMessages?: boolean;
}

/**
 * Boots a SlackService exactly the way `startAccount` does and returns the
 * handlers Bolt actually received.
 */
export async function bootHarness(
  config: ElizaConfig,
  options: BootOptions = {},
): Promise<SlackHarness> {
  const runtime = runtimeFromPersistedConfig(config, options);
  const accountId = options.accountId ?? "default";
  const account = resolveSlackAccount(runtime, accountId);

  const settings = {
    allowedChannelIds: undefined,
    shouldIgnoreBotMessages: options.ignoreBotMessages ?? true,
    shouldRespondOnlyToMentions: options.globalRequireMention ?? false,
  };

  const policy = await resolveSlackAccountPolicy({
    account,
    lookups: options.lookups ?? fakeLookups(),
    envAllowedChannelIds: options.envAllowedChannelIds ?? [],
    globalRequireMention: settings.shouldRespondOnlyToMentions,
    ignoreBotMessages: settings.shouldIgnoreBotMessages,
  });

  const service = Object.create(SlackService.prototype) as SlackService;

  const state = {
    accountId,
    account,
    app: {} as never,
    client: {} as never,
    userClient: null,
    botUserId: BOT_USER_ID,
    teamId: "T0TEAM000",
    settings,
    allowedChannelIds: new Set(policy.allowedChannelIds),
    dynamicChannelIds: new Set<string>(),
    policy,
    userCache: new Map<string, SlackUser>(),
    channelCache: new Map<string, SlackChannel>(),
    isConnected: true,
  };

  Object.assign(service, {
    runtime,
    character: runtime.character,
    settings,
    defaultAccountId: accountId,
    accountStates: new Map([[accountId, state]]),
    accountStarts: new Map(),
    allowedChannelIds: new Set<string>(),
    dynamicChannelIds: new Set<string>(),
    userCache: new Map(),
    channelCache: new Map(),
    botUserId: BOT_USER_ID,
    teamId: "T0TEAM000",
    isConnected: true,
  });

  const processAgentMessage = vi.fn().mockResolvedValue(undefined);
  Object.assign(service, {
    processAgentMessage,
    buildMemoryFromMessage: vi.fn().mockResolvedValue({ id: "mem-1" }),
    buildMemoryFromMention: vi.fn().mockResolvedValue({ id: "mem-1" }),
    ensureRoomExists: vi.fn().mockResolvedValue({ id: "room-1" }),
    getUser: vi.fn().mockResolvedValue(null),
  });

  const handlers: CapturedSlackHandlers = {};

  const app = {
    message: (
      fn: (args: { message: unknown; client: unknown }) => Promise<void>,
    ) => {
      handlers.message = fn;
    },
    event: (name: string, fn: (args: never) => Promise<void>) => {
      if (name === "app_mention") {
        handlers.appMention = fn as typeof handlers.appMention;
      }
      if (name === "member_joined_channel") {
        handlers.memberJoined = fn as typeof handlers.memberJoined;
      }
    },
  };

  (
    service as unknown as { registerEventHandlers: (s: unknown) => void }
  ).registerEventHandlers({ ...state, app });

  return { service, runtime, account, policy, handlers, processAgentMessage };
}

/** A plain inbound channel message payload. */
export function channelMessage(overrides: Record<string, unknown> = {}) {
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

/** An inbound app_mention payload. */
export function appMentionEvent(overrides: Record<string, unknown> = {}) {
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

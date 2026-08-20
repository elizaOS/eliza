/**
 * Adversarial authorization tests for the account-scoped Slack policy compiler.
 * The directory client behaves like Slack pagination while decisions exercise
 * cold-start name resolution, event classification, and dynamic membership.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount, SlackAccountConfig } from "./accounts";
import {
  SlackAccountPolicyResolver,
  type SlackInboundEventContext,
  SlackPolicyConfigurationError,
  type SlackPolicyDirectoryClient,
} from "./policy";

const CHANNEL = "C0123ABCD";
const PRIVATE = "G0123ABCD";
const DM = "D0123ABCD";
const MPIM = "G0MPIM123";
const ALICE = "opaque-user-alice";
const BOB = "opaque-user-bob";
const TEAM = "T0TEAM000";

function account(
  config: SlackAccountConfig,
  hasStructuredPolicy = true,
  accountId = "default",
): ResolvedSlackAccount {
  return {
    accountId,
    enabled: true,
    role: "AGENT",
    botToken: "xoxb-test",
    appToken: "xapp-test",
    botTokenSource: "config",
    appTokenSource: "config",
    config,
    channels: Object.fromEntries(
      Object.entries(config.channels ?? {}).filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
          Boolean(entry[1]),
      ),
    ),
    dm: config.dm,
    requireMention: config.requireMention,
    hasStructuredPolicy,
  };
}

function directory(
  overrides: {
    channels?: Array<Record<string, unknown>>;
    users?: Array<Record<string, unknown>>;
    infoError?: Error;
  } = {},
): SlackPolicyDirectoryClient {
  const channels = overrides.channels ?? [
    { id: CHANNEL, name: "ops", is_channel: true },
    { id: PRIVATE, name: "leadership", is_group: true, is_private: true },
    { id: DM, is_im: true },
    { id: MPIM, name: "mpdm-team", is_mpim: true },
  ];
  return {
    conversations: {
      list: vi.fn().mockResolvedValue({ channels }),
      info: vi.fn().mockImplementation(async ({ channel }) => {
        if (overrides.infoError) throw overrides.infoError;
        return { channel: channels.find((entry) => entry.id === channel) };
      }),
    },
    users: {
      list: vi.fn().mockResolvedValue({
        members: overrides.users ?? [
          {
            id: ALICE,
            name: "alice",
            profile: { display_name: "Alice Example" },
          },
          { id: BOB, name: "bob", profile: { display_name: "Bob Example" } },
        ],
      }),
    },
  } as SlackPolicyDirectoryClient;
}

function event(
  overrides: Partial<SlackInboundEventContext> = {},
): SlackInboundEventContext {
  return {
    eventType: "message",
    channelId: CHANNEL,
    userId: ALICE,
    channelType: "channel",
    isThread: false,
    isMentioned: true,
    isBotMessage: false,
    teamId: TEAM,
    ...overrides,
  };
}

async function resolver(
  config: SlackAccountConfig,
  options: {
    client?: SlackPolicyDirectoryClient;
    hasStructuredPolicy?: boolean;
    pairingAllowed?: boolean;
    accountId?: string;
    workspace?: { teamId: string; botUserId: string; enterpriseId?: string };
    cache?: {
      maxConversationKinds?: number;
      conversationKindTtlMs?: number;
      maxDynamicChannels?: number;
      now?: () => number;
    };
  } = {},
) {
  return SlackAccountPolicyResolver.create({
    account: account(
      config,
      options.hasStructuredPolicy ?? true,
      options.accountId,
    ),
    client: options.client ?? directory(),
    workspace: options.workspace ?? { teamId: TEAM, botUserId: "bot-user" },
    ...(options.cache ? { cache: options.cache } : {}),
    checkPairing: vi.fn().mockResolvedValue({
      allowed: options.pairingAllowed ?? false,
      replyMessage: "pair first",
    }),
  });
}

describe("SlackAccountPolicyResolver startup compilation", () => {
  it("resolves channel and user names to immutable IDs before admission", async () => {
    const policy = await resolver({
      groupPolicy: "allowlist",
      channels: { ops: { users: ["alice"], requireMention: false } },
    });

    await expect(
      policy.authorize(event({ isMentioned: false })),
    ).resolves.toMatchObject({
      allowed: true,
      channelPolicyKey: "ops",
    });
    await expect(
      policy.authorize(event({ userId: BOB })),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "user_not_allowed",
    });
  });

  it("fails startup on unresolved or ambiguous authorization names", async () => {
    const ambiguous = directory({
      channels: [
        { id: CHANNEL, name: "ops", is_channel: true },
        { id: PRIVATE, name: "ops", is_private: true },
      ],
    });
    await expect(
      resolver(
        { groupPolicy: "allowlist", channels: { ops: { enabled: false } } },
        { client: ambiguous },
      ),
    ).rejects.toThrow(/resolved to 2 conversations/);

    const duplicateUsers = directory({
      users: [
        { id: ALICE, name: "alex" },
        { id: BOB, profile: { display_name: "Alex" } },
      ],
    });
    await expect(
      resolver(
        {
          groupPolicy: "allowlist",
          channels: { [CHANNEL]: { users: ["alex"] } },
        },
        { client: duplicateUsers },
      ),
    ).rejects.toThrow(/resolved to 2 active users/);
  });

  it("supports explicit opaque Slack IDs without prefix assumptions", async () => {
    const client = directory({ users: [] });
    const opaqueChannelId = "opaque-channel-identifier";
    const policy = await resolver(
      {
        groupPolicy: "allowlist",
        channels: {
          [`id:${opaqueChannelId}`]: { users: [`id:${ALICE}`] },
        },
      },
      { client },
    );

    expect(client.conversations.list).not.toHaveBeenCalled();
    expect(client.users.list).not.toHaveBeenCalled();
    await expect(
      policy.authorize(
        event({ channelId: opaqueChannelId, channelType: "channel" }),
      ),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("treats an explicit empty user list as deny-all", async () => {
    const policy = await resolver({
      groupPolicy: "allowlist",
      channels: { [CHANNEL]: { users: [] } },
    });
    await expect(policy.authorize(event())).resolves.toMatchObject({
      allowed: false,
      reason: "user_not_allowed",
    });
  });

  it("rejects accepted security settings that the connector cannot enforce", async () => {
    await expect(
      resolver({
        groupPolicy: "allowlist",
        channels: { [CHANNEL]: { tools: { allow: ["shell"] } } },
      }),
    ).rejects.toBeInstanceOf(SlackPolicyConfigurationError);
    await expect(
      resolver({ groupPolicy: "allowlist", actions: { messages: false } }),
    ).rejects.toThrow(/cannot enforce: actions/);
  });

  it("compiles exact reaction names and rejects dangling or non-Slack entries", async () => {
    await expect(
      resolver({
        groupPolicy: "open",
        reactionNotifications: "allowlist",
        reactionAllowlist: [":thumbsup:", "ship_it"],
      }),
    ).resolves.toBeInstanceOf(SlackAccountPolicyResolver);
    await expect(
      resolver({ groupPolicy: "open", reactionAllowlist: ["thumbsup"] }),
    ).rejects.toThrow(/requires reactionNotifications=allowlist/);
    await expect(
      resolver({
        groupPolicy: "open",
        reactionNotifications: "allowlist",
        reactionAllowlist: [42],
      }),
    ).rejects.toThrow(/must be Slack reaction names/);
  });
});

describe("SlackAccountPolicyResolver event policy", () => {
  it("fails closed for missing or foreign workspace identity", async () => {
    const policy = await resolver({ groupPolicy: "open" });
    await expect(
      policy.authorize(event({ teamId: undefined })),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "workspace_identity_missing",
    });
    await expect(
      policy.authorize(event({ teamId: "foreign-workspace" })),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "workspace_identity_mismatch",
    });
  });

  it("requires auth.test workspace identity before compiling policy", async () => {
    await expect(
      resolver(
        { groupPolicy: "open" },
        { workspace: { teamId: "", botUserId: "" } },
      ),
    ).rejects.toThrow(/did not return a workspace team_id/);
  });

  it("preserves env-only bot behavior when no structured policy exists", async () => {
    const policy = await resolver(
      {
        allowedChannelIds: [CHANNEL],
        shouldIgnoreBotMessages: false,
      },
      { hasStructuredPolicy: false },
    );
    await expect(
      policy.authorize(event({ userId: "bot-identity", isBotMessage: true })),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("applies sender, channel, ownership, and emoji policy to reactions", async () => {
    const own = await resolver({
      groupPolicy: "allowlist",
      channels: { [CHANNEL]: { users: [`id:${ALICE}`] } },
    });
    const reactionEvent = event({ eventType: "reaction", isMentioned: false });
    await expect(
      own.authorizeReaction(reactionEvent, "thumbsup"),
    ).resolves.toMatchObject({ allowed: true });
    expect(own.isReactionTargetAllowed(true)).toBe(true);
    expect(own.isReactionTargetAllowed(false)).toBe(false);
    await expect(
      own.authorizeReaction(
        { ...reactionEvent, userId: "bot-user", isBotMessage: true },
        "thumbsup",
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "bot_not_allowed",
    });
    await expect(
      own.authorizeReaction({ ...reactionEvent, userId: BOB }, "thumbsup"),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "user_not_allowed",
    });

    const allowlist = await resolver({
      groupPolicy: "open",
      reactionNotifications: "allowlist",
      reactionAllowlist: ["thumbsup"],
    });
    await expect(
      allowlist.authorizeReaction(reactionEvent, "thumbsup"),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      allowlist.authorizeReaction(reactionEvent, "eyes"),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "reaction_not_allowed",
    });
  });

  it("does not let a dynamic join widen groupPolicy=allowlist", async () => {
    const policy = await resolver({
      groupPolicy: "allowlist",
      channels: { [CHANNEL]: {} },
    });
    expect(await policy.registerBotJoin(PRIVATE)).toBe(false);
    await expect(
      policy.authorize(event({ channelId: PRIVATE, channelType: "group" })),
    ).resolves.toMatchObject({ allowed: false, reason: "channel_not_allowed" });
  });

  it("applies explicit channel deny and bot precedence under open policy", async () => {
    const policy = await resolver({
      groupPolicy: "open",
      allowBots: false,
      channels: {
        [CHANNEL]: { enabled: false },
        [PRIVATE]: { allowBots: true },
      },
    });
    await expect(policy.authorize(event())).resolves.toMatchObject({
      allowed: false,
      reason: "channel_disabled",
    });
    await expect(
      policy.authorize(
        event({
          channelId: PRIVATE,
          channelType: "group",
          userId: "bot-identity",
          isBotMessage: true,
        }),
      ),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("classifies App Home as DM and never applies wildcard channel denial", async () => {
    const policy = await resolver({
      groupPolicy: "allowlist",
      channels: { "*": { enabled: false } },
      dm: { policy: "allowlist", allowFrom: [`id:${ALICE}`] },
    });
    await expect(
      policy.authorize(
        event({
          channelId: DM,
          channelType: "app_home",
          subtype: "app_home",
          isMentioned: false,
        }),
      ),
    ).resolves.toMatchObject({
      allowed: true,
      conversationKind: "app_home",
    });
  });

  it("enforces DM allowlist, pairing, MPIM enablement, and MPIM channel list", async () => {
    const policy = await resolver({
      groupPolicy: "disabled",
      dm: {
        policy: "allowlist",
        allowFrom: [`id:${ALICE}`],
        groupEnabled: true,
        groupChannels: [MPIM],
      },
    });
    await expect(
      policy.authorize(event({ channelId: DM, channelType: "im" })),
    ).resolves.toMatchObject({
      allowed: true,
      conversationKind: "direct_message",
    });
    await expect(
      policy.authorize(
        event({ channelId: DM, channelType: "im", userId: BOB }),
      ),
    ).resolves.toMatchObject({ allowed: false, reason: "dm_user_not_allowed" });
    await expect(
      policy.authorize(event({ channelId: MPIM, channelType: "mpim" })),
    ).resolves.toMatchObject({
      allowed: true,
      conversationKind: "multi_party_direct_message",
    });

    const pairing = await resolver(
      { groupPolicy: "disabled", dm: { policy: "pairing" } },
      { pairingAllowed: false },
    );
    await expect(
      pairing.authorize(event({ channelId: DM, channelType: "im" })),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "pairing_required",
      pairingReply: "pair first",
    });
  });

  it("preserves thread lane classification without bypassing parent policy", async () => {
    const policy = await resolver({
      groupPolicy: "allowlist",
      channels: { [CHANNEL]: { requireMention: true } },
    });
    await expect(
      policy.authorize(event({ isThread: true, isMentioned: false })),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "mention_required",
      isThread: true,
    });
  });

  it("surfaces lookup failure before an app_mention can be admitted", async () => {
    const policy = await resolver(
      { groupPolicy: "open" },
      {
        client: directory({
          channels: [],
          infoError: new Error("scope missing"),
        }),
      },
    );
    await expect(
      policy.authorize(
        event({ eventType: "app_mention", channelType: undefined }),
      ),
    ).rejects.toThrow("scope missing");
  });

  it("bounds and expires event-time conversation classification", async () => {
    let now = 0;
    const first = "opaque-conversation-one";
    const second = "opaque-conversation-two";
    const client = directory({
      channels: [
        { id: first, is_channel: true },
        { id: second, is_channel: true },
      ],
    });
    const policy = await resolver(
      { groupPolicy: "open" },
      {
        client,
        cache: {
          maxConversationKinds: 1,
          conversationKindTtlMs: 10,
          now: () => now,
        },
      },
    );

    const mentionEvent = (channelId: string) =>
      event({ eventType: "app_mention", channelId, channelType: undefined });
    await policy.authorize(mentionEvent(first));
    await policy.authorize(mentionEvent(first));
    expect(client.conversations.info).toHaveBeenCalledTimes(1);

    await policy.authorize(mentionEvent(second));
    await policy.authorize(mentionEvent(first));
    expect(client.conversations.info).toHaveBeenCalledTimes(3);

    now = 11;
    await policy.authorize(mentionEvent(first));
    expect(client.conversations.info).toHaveBeenCalledTimes(4);
  });

  it("bounds legacy dynamic-join compatibility state", async () => {
    const policy = await resolver(
      { allowedChannelIds: [CHANNEL] },
      {
        hasStructuredPolicy: false,
        cache: { maxDynamicChannels: 1 },
      },
    );
    await policy.registerBotJoin("joined-one");
    await policy.registerBotJoin("joined-two");
    expect(policy.isChannelAllowed("joined-one")).toBe(false);
    expect(policy.isChannelAllowed("joined-two")).toBe(true);
  });

  it("keeps workspace policies isolated for identical names and user labels", async () => {
    const first = await resolver(
      { groupPolicy: "allowlist", channels: { ops: { users: ["alice"] } } },
      { accountId: "workspace-a" },
    );
    const secondClient = directory({
      channels: [{ id: "C0999ZZZZ", name: "ops", is_channel: true }],
      users: [{ id: "workspace-b-alice", name: "alice" }],
    });
    const second = await resolver(
      { groupPolicy: "allowlist", channels: { ops: { users: ["alice"] } } },
      { client: secondClient, accountId: "workspace-b" },
    );

    await expect(first.authorize(event())).resolves.toMatchObject({
      allowed: true,
    });
    await expect(
      second.authorize(event({ channelId: CHANNEL, userId: ALICE })),
    ).resolves.toMatchObject({ allowed: false, reason: "channel_not_allowed" });
  });

  it("rejects repeating pagination cursors when compiling channels directory", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [],
          response_metadata: { next_cursor: "repeated-cursor" },
        }),
        info: vi.fn(),
      },
      users: {
        list: vi.fn().mockResolvedValue({ members: [] }),
      },
    } as unknown as SlackPolicyDirectoryClient;

    await expect(
      resolver(
        { groupPolicy: "allowlist", channels: { ops: true } },
        { client, accountId: "test-acc" },
      ),
    ).rejects.toThrowError(SlackPolicyConfigurationError);
  });

  it("rejects repeating pagination cursors when compiling users directory", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({ channels: [] }),
        info: vi.fn(),
      },
      users: {
        list: vi.fn().mockResolvedValue({
          members: [],
          response_metadata: { next_cursor: "repeated-cursor" },
        }),
      },
    } as unknown as SlackPolicyDirectoryClient;

    await expect(
      resolver(
        { dm: { policy: "allowlist", allowFrom: ["alice"] } },
        { client, accountId: "test-acc" },
      ),
    ).rejects.toThrowError(SlackPolicyConfigurationError);
  });

  it("rejects channel directory pagination exceeding the maximum page limit", async () => {
    let callCount = 0;
    const client = {
      conversations: {
        list: vi.fn().mockImplementation(async () => {
          callCount += 1;
          return {
            channels: [],
            response_metadata: { next_cursor: `cursor-${callCount}` },
          };
        }),
        info: vi.fn(),
      },
      users: {
        list: vi.fn().mockResolvedValue({ members: [] }),
      },
    } as unknown as SlackPolicyDirectoryClient;

    await expect(
      resolver(
        { groupPolicy: "allowlist", channels: { ops: true } },
        { client, accountId: "test-acc" },
      ),
    ).rejects.toThrowError(
      /channel directory exceeds the 250-page safety limit/,
    );
  });

  it("rejects user directory pagination exceeding the maximum page limit", async () => {
    let callCount = 0;
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({ channels: [] }),
        info: vi.fn(),
      },
      users: {
        list: vi.fn().mockImplementation(async () => {
          callCount += 1;
          return {
            members: [],
            response_metadata: { next_cursor: `cursor-${callCount}` },
          };
        }),
      },
    } as unknown as SlackPolicyDirectoryClient;

    await expect(
      resolver(
        { dm: { policy: "allowlist", allowFrom: ["alice"] } },
        { client, accountId: "test-acc" },
      ),
    ).rejects.toThrowError(/user directory exceeds the 250-page safety limit/);
  });
});

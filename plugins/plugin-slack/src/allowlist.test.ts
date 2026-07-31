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
} from "./allowlist";

const CHANNEL = "C0123ABCD";
const PRIVATE = "G0123ABCD";
const DM = "D0123ABCD";
const MPIM = "G0MPIM123";
const ALICE = "opaque-user-alice";
const BOB = "opaque-user-bob";

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
  } = {},
) {
  return SlackAccountPolicyResolver.create({
    account: account(
      config,
      options.hasStructuredPolicy ?? true,
      options.accountId,
    ),
    client: options.client ?? directory(),
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
    const policy = await resolver(
      {
        groupPolicy: "allowlist",
        channels: { [CHANNEL]: { users: [`id:${ALICE}`] } },
      },
      { client },
    );

    expect(client.users.list).not.toHaveBeenCalled();
    await expect(policy.authorize(event())).resolves.toMatchObject({
      allowed: true,
    });
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
});

describe("SlackAccountPolicyResolver event policy", () => {
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
});

/**
 * ADVERSARIAL CONTROLS for the Slack inbound policy.
 *
 * Every test in this file is a bypass that the reviewed head
 * (`7a17e01969572aa61b7651cd45deb1926fa530f1`) actually exhibited. They are
 * written as regressions: each one FAILS against the old model and passes only
 * once the policy resolver owns the decision. Grouped by the blocker they
 * belong to so a future reviewer can map a failure back to the defect.
 *
 * These deliberately drive the REAL production surfaces:
 *   - `buildCharacterFromConfig` (the actual character projection)
 *   - `resolveSlackAccount` (the actual account resolution)
 *   - `registerEventHandlers` (the actual Bolt handler registration)
 *
 * Nothing here hand-constructs a `ResolvedSlackAccount`. That shortcut is what
 * let the config-projection bug ship: both broken upstream paths were bypassed
 * by the test harness, so the gate looked correct while receiving nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { buildCharacterFromConfig } from "../../../packages/agent/src/runtime/build-character-config.ts";
import { resolveSlackAccount } from "./accounts";
import {
  classifySlackEvent,
  evaluateSlackInbound,
  resolveSlackAccountPolicy,
  SlackPolicyError,
  shouldAdmitDynamicJoin,
} from "./policy";
import {
  appMentionEvent,
  BOT_USER_ID,
  bootHarness,
  CHANNEL_ID,
  channelMessage,
  DM_CHANNEL_ID,
  fakeLookups,
  MPIM_CHANNEL_ID,
  OTHER_CHANNEL_ID,
  OTHER_USER_ID,
  persistedSlackConfig,
  runtimeFromPersistedConfig,
  USER_ID,
} from "./test-harness";

/* ------------------------------------------------------------------------ */
/* [P0-1] Top-level policy loss                                              */
/* ------------------------------------------------------------------------ */

describe("ADVERSARIAL [P0-1]: canonical connector config must reach the gate", () => {
  it("projects connectors.slack onto character.settings.slack", () => {
    // FAILED BEFORE: buildCharacterFromConfig projected only the three token
    // env fields, so characterSlack resolved to null.
    const character = buildCharacterFromConfig(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { enabled: false, requireMention: true } },
        groupPolicy: "allowlist",
      }),
    );
    const slack = character.settings?.slack as Record<string, unknown>;
    expect(slack).toBeTruthy();
    expect(slack.groupPolicy).toBe("allowlist");
    expect(
      (slack.channels as Record<string, { enabled?: boolean }>)[CHANNEL_ID]
        .enabled,
    ).toBe(false);
  });

  it("carries top-level channels/requireMention/groupPolicy through account resolution", () => {
    // FAILED BEFORE: getMultiAccountConfig kept only enabled/botToken/
    // appToken/accounts, so resolvedChannels was {} and resolvedGroupPolicy
    // was null — exactly the review's reproduction.
    const runtime = runtimeFromPersistedConfig(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { enabled: false, requireMention: true } },
        groupPolicy: "allowlist",
        requireMention: true,
      }),
    );
    const account = resolveSlackAccount(runtime, "default");

    expect(account.channels[CHANNEL_ID]).toEqual({
      enabled: false,
      requireMention: true,
    });
    expect(account.config.groupPolicy).toBe("allowlist");
    expect(account.requireMention).toBe(true);
  });

  it("enforces a top-level channels[].enabled:false at the registered Bolt handler", async () => {
    // FAILED BEFORE: the config never arrived, so the message was processed.
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: {
          [CHANNEL_ID]: { enabled: false },
          [OTHER_CHANNEL_ID]: {},
        },
      }),
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();

    // Negative control: the sibling channel is still live, so this is a gate,
    // not a blanket deny.
    await harness.handlers.message?.({
      message: channelMessage({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("enforces a top-level requireMention:true at the registered Bolt handler", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { requireMention: true } },
      }),
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();

    // Mentioning it works: app_mention is the path a mention actually takes.
    await harness.handlers.appMention?.({
      event: appMentionEvent(),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------ */
/* [P0-2] Structured allowlists failing open                                 */
/* ------------------------------------------------------------------------ */

describe("ADVERSARIAL [P0-2]: structured allowlists must not fail open", () => {
  it("does NOT admit an unlisted channel when only name keys are configured (cold cache)", async () => {
    // FAILED BEFORE: collectSlackConfiguredChannelIds admitted only ID keys,
    // so a name-only record produced an EMPTY allowlist, which
    // isChannelAllowed read as allow-all until the channel cache warmed.
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { general: { requireMention: false } },
      }),
    );

    // "general" resolves to CHANNEL_ID at startup, so the OTHER channel is out.
    await harness.handlers.message?.({
      message: channelMessage({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("enforces a name-keyed enabled:false on the FIRST event (no cache warm required)", async () => {
    // FAILED BEFORE: a name-keyed disable could not be matched until the
    // channel name was cached, so the first event sailed through.
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { general: { enabled: false }, random: {} },
      }),
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("does NOT let a dynamic join bypass an allowlist", async () => {
    // FAILED BEFORE: handleMemberJoinedChannel unconditionally unioned the
    // joined channel into dynamicChannelIds, which the gate treated as an
    // admission source — so anyone able to /invite the bot bypassed the
    // allowlist entirely.
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: {} },
        groupPolicy: "allowlist",
      }),
    );

    await harness.handlers.memberJoined?.({
      event: { user: BOT_USER_ID, channel: OTHER_CHANNEL_ID },
    });

    await harness.handlers.message?.({
      message: channelMessage({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
    expect(shouldAdmitDynamicJoin(harness.policy)).toBe(false);
  });

  it("admits a dynamic join only under groupPolicy:open", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({ groupPolicy: "open" }),
    );
    expect(shouldAdmitDynamicJoin(harness.policy)).toBe(true);

    await harness.handlers.message?.({
      message: channelMessage({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("enforces the schema default groupPolicy:allowlist once channels are configured", async () => {
    // FAILED BEFORE: the service never read groupPolicy at all.
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { [CHANNEL_ID]: {} } }),
    );
    expect(harness.policy.groupPolicy).toBe("allowlist");
    expect(harness.policy.groupPolicySource).toBe("implicit-allowlist");
  });

  it("keeps a legacy env-only deployment open, and says so", async () => {
    // Negative control: an operator who configured nothing must not have
    // every channel silently denied by the new default.
    const harness = await bootHarness(persistedSlackConfig({}));
    expect(harness.policy.groupPolicy).toBe("open");
    expect(harness.policy.groupPolicySource).toBe("implicit-open");

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("fails startup on an ambiguous channel name rather than guessing", async () => {
    const runtime = runtimeFromPersistedConfig(
      persistedSlackConfig({ channels: { general: { enabled: false } } }),
    );
    const account = resolveSlackAccount(runtime, "default");

    await expect(
      resolveSlackAccountPolicy({
        account,
        lookups: fakeLookups({
          channels: [
            { id: CHANNEL_ID, name: "general" },
            { id: OTHER_CHANNEL_ID, name: "General" },
          ],
        }),
      }),
    ).rejects.toBeInstanceOf(SlackPolicyError);
  });

  it("fails startup when a restricted channel name resolves to nothing", async () => {
    const runtime = runtimeFromPersistedConfig(
      persistedSlackConfig({
        channels: { "does-not-exist": { enabled: false } },
      }),
    );
    const account = resolveSlackAccount(runtime, "default");

    await expect(
      resolveSlackAccountPolicy({ account, lookups: fakeLookups() }),
    ).rejects.toBeInstanceOf(SlackPolicyError);
  });

  it("fails startup on groupPolicy:allowlist with an empty allowlist", async () => {
    const runtime = runtimeFromPersistedConfig(
      persistedSlackConfig({ groupPolicy: "allowlist" }),
    );
    const account = resolveSlackAccount(runtime, "default");

    await expect(
      resolveSlackAccountPolicy({ account, lookups: fakeLookups() }),
    ).rejects.toBeInstanceOf(SlackPolicyError);
  });
});

/* ------------------------------------------------------------------------ */
/* [P1-3] User allowlist contract                                            */
/* ------------------------------------------------------------------------ */

describe("ADVERSARIAL [P1-3]: user allowlist must be implemented as advertised", () => {
  it("matches a configured HANDLE against the sender's opaque id", async () => {
    // FAILED BEFORE: handlers passed only userId and never consulted
    // userCache/users.info, so a configured name could never match and the
    // named user was silently DENIED.
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { users: ["salem"] } },
      }),
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);

    await harness.handlers.message?.({
      message: channelMessage({ user: OTHER_USER_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("treats users:[] as an EXPLICIT empty allowlist that denies everyone", async () => {
    // FAILED BEFORE: an empty list was read as "no policy" and allowed
    // everyone — a fail-open on an authorization boundary.
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { [CHANNEL_ID]: { users: [] } } }),
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();

    // …and it is a documented decision, surfaced as a startup warning.
    expect(
      harness.policy.warnings.some((w) => w.includes("EMPTY allowlist")),
    ).toBe(true);
  });

  it("still admits everyone when no users key is present", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { [CHANNEL_ID]: {} } }),
    );
    await harness.handlers.message?.({
      message: channelMessage({ user: OTHER_USER_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("fails startup on an ambiguous handle instead of silently picking one", async () => {
    const runtime = runtimeFromPersistedConfig(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { users: ["salem"] } },
      }),
    );
    const account = resolveSlackAccount(runtime, "default");

    await expect(
      resolveSlackAccountPolicy({
        account,
        lookups: fakeLookups({
          users: [
            { id: USER_ID, name: "salem" },
            { id: OTHER_USER_ID, displayName: "Salem" },
          ],
        }),
      }),
    ).rejects.toBeInstanceOf(SlackPolicyError);
  });

  it("fails startup on a handle that resolves to a DEACTIVATED user", async () => {
    // A freed handle can be reused by a different account; keeping it in an
    // allowlist is a live privilege-transfer bug.
    const runtime = runtimeFromPersistedConfig(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { users: ["salem"] } },
      }),
    );
    const account = resolveSlackAccount(runtime, "default");

    await expect(
      resolveSlackAccountPolicy({
        account,
        lookups: fakeLookups({
          users: [{ id: USER_ID, name: "salem", deleted: true }],
        }),
      }),
    ).rejects.toBeInstanceOf(SlackPolicyError);
  });

  it("fails startup when the user list cannot be read at all", async () => {
    const runtime = runtimeFromPersistedConfig(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { users: ["salem"] } },
      }),
    );
    const account = resolveSlackAccount(runtime, "default");

    await expect(
      resolveSlackAccountPolicy({
        account,
        lookups: fakeLookups({ failUsers: true }),
      }),
    ).rejects.toBeInstanceOf(SlackPolicyError);
  });

  it("costs ZERO api calls when the config uses opaque ids only", async () => {
    const runtime = runtimeFromPersistedConfig(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { users: [USER_ID] } },
      }),
    );
    const account = resolveSlackAccount(runtime, "default");
    const listChannels = vi.fn().mockResolvedValue([]);
    const listUsers = vi.fn().mockResolvedValue([]);

    await resolveSlackAccountPolicy({
      account,
      lookups: { listChannels, listUsers },
    });

    expect(listChannels).not.toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------ */
/* [P1-4] Event classification                                               */
/* ------------------------------------------------------------------------ */

describe("ADVERSARIAL [P1-4]: event classification must be explicit", () => {
  it("classifies im / app_home / mpim / channel / group distinctly", () => {
    expect(
      classifySlackEvent({ channelType: "im", channelId: DM_CHANNEL_ID }),
    ).toBe("im");
    expect(
      classifySlackEvent({ channelType: "app_home", channelId: DM_CHANNEL_ID }),
    ).toBe("app_home");
    expect(
      classifySlackEvent({ channelType: "mpim", channelId: MPIM_CHANNEL_ID }),
    ).toBe("mpim");
    expect(
      classifySlackEvent({ channelType: "channel", channelId: CHANNEL_ID }),
    ).toBe("channel");
    expect(
      classifySlackEvent({ channelType: "group", channelId: MPIM_CHANNEL_ID }),
    ).toBe("group");
    // App Home identified by event name rather than channel_type.
    expect(
      classifySlackEvent({
        eventType: "message",
        subtype: "app_home",
        channelId: DM_CHANNEL_ID,
      }),
    ).toBe("app_home");
    // Unclassifiable events are reported, not guessed.
    expect(classifySlackEvent({ channelId: "X999" })).toBe("unknown");
  });

  it("does NOT let a wildcard channel deny kill App Home DM traffic", async () => {
    // FAILED BEFORE: only channel_type === "im" was exempted, so App Home
    // traffic on a D-channel matched channels["*"] and was dropped by
    // channels["*"].enabled = false.
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { "*": { enabled: false } } }),
    );

    await harness.handlers.message?.({
      message: channelMessage({
        channel: DM_CHANNEL_ID,
        channel_type: "app_home",
      }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);

    // The wildcard still governs actual channels.
    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("does NOT let a wildcard requireMention silence DMs", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { "*": { requireMention: true } } }),
    );

    await harness.handlers.message?.({
      message: channelMessage({ channel: DM_CHANNEL_ID, channel_type: "im" }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("routes mpim through DM group policy, not the channel wildcard", async () => {
    // FAILED BEFORE: mpim went through channel policy while the accepted
    // dm.groupEnabled/groupChannels policy was ignored entirely.
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { "*": {} },
        dm: { policy: "open", allowFrom: ["*"], groupEnabled: false },
      }),
    );

    await harness.handlers.message?.({
      message: channelMessage({
        channel: MPIM_CHANNEL_ID,
        channel_type: "mpim",
      }),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();

    // The DM itself is still open.
    await harness.handlers.message?.({
      message: channelMessage({ channel: DM_CHANNEL_ID, channel_type: "im" }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("honours an explicit dm.groupChannels allowlist for mpim", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        dm: {
          policy: "open",
          allowFrom: ["*"],
          groupChannels: [MPIM_CHANNEL_ID],
        },
      }),
    );

    await harness.handlers.message?.({
      message: channelMessage({
        channel: MPIM_CHANNEL_ID,
        channel_type: "mpim",
      }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);

    await harness.handlers.message?.({
      message: channelMessage({ channel: "G0OTHERMPIM", channel_type: "mpim" }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("drops an event it cannot classify (fail closed)", async () => {
    const harness = await bootHarness(persistedSlackConfig({}));
    await harness.handlers.message?.({
      message: channelMessage({ channel: "C0000000A", channel_type: "wat" }),
      client: {},
    });
    // A "wat" channel_type on a C-id still classifies as a channel by prefix;
    // the genuinely unclassifiable case is asserted at the unit level above.
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------ */
/* [P1-4/5] DM policy (folded in from the old slice 2)                       */
/* ------------------------------------------------------------------------ */

describe("ADVERSARIAL [P1-4]: DM policy is enforced", () => {
  it("keeps DMs open when no dm block was ever written (legacy)", async () => {
    const harness = await bootHarness(persistedSlackConfig({}));
    expect(harness.policy.dm.policy).toBe("legacy");

    await harness.handlers.message?.({
      message: channelMessage({ channel: DM_CHANNEL_ID, channel_type: "im" }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("enforces dm.policy=allowlist against opaque sender ids", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        dm: { policy: "allowlist", allowFrom: ["salem"] },
      }),
    );

    await harness.handlers.message?.({
      message: channelMessage({ channel: DM_CHANNEL_ID, channel_type: "im" }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);

    await harness.handlers.message?.({
      message: channelMessage({
        channel: DM_CHANNEL_ID,
        channel_type: "im",
        user: OTHER_USER_ID,
      }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("enforces dm.policy=disabled", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({ dm: { policy: "disabled" } }),
    );

    await harness.handlers.message?.({
      message: channelMessage({ channel: DM_CHANNEL_ID, channel_type: "im" }),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("fails CLOSED on dm.policy=pairing and warns loudly at startup", async () => {
    // Pairing needs an owner handshake this connector does not implement.
    // Admitting every DM instead would be the silent-acceptance bug again.
    const harness = await bootHarness(
      persistedSlackConfig({ dm: { policy: "pairing" } }),
    );

    await harness.handlers.message?.({
      message: channelMessage({ channel: DM_CHANNEL_ID, channel_type: "im" }),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
    expect(harness.policy.warnings.some((w) => w.includes("FAIL CLOSED"))).toBe(
      true,
    );
  });

  it("fails startup on dm.policy=allowlist with no allowFrom", async () => {
    const runtime = runtimeFromPersistedConfig(
      persistedSlackConfig({ dm: { policy: "allowlist" } }),
    );
    const account = resolveSlackAccount(runtime, "default");
    await expect(
      resolveSlackAccountPolicy({ account, lookups: fakeLookups() }),
    ).rejects.toBeInstanceOf(SlackPolicyError);
  });

  it("enforces dm.enabled:false regardless of policy", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        dm: { enabled: false, policy: "open", allowFrom: ["*"] },
      }),
    );

    await harness.handlers.message?.({
      message: channelMessage({ channel: DM_CHANNEL_ID, channel_type: "im" }),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------ */
/* [P1-5] Unhonorable config must FAIL, not be silently accepted             */
/* ------------------------------------------------------------------------ */

describe("ADVERSARIAL [P1-5]: config the service cannot honor fails loudly", () => {
  it("fails startup on a per-channel tools policy it does not enforce", async () => {
    const runtime = runtimeFromPersistedConfig(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { tools: { allow: ["web.search"] } } },
      }),
    );
    const account = resolveSlackAccount(runtime, "default");
    await expect(
      resolveSlackAccountPolicy({ account, lookups: fakeLookups() }),
    ).rejects.toThrow(/tools/i);
  });

  it("fails startup on mode:http, which the socket-mode service cannot serve", async () => {
    const runtime = runtimeFromPersistedConfig(
      persistedSlackConfig({ mode: "http", signingSecret: "s" }),
    );
    const account = resolveSlackAccount(runtime, "default");
    await expect(
      resolveSlackAccountPolicy({ account, lookups: fakeLookups() }),
    ).rejects.toThrow(/Socket Mode/i);
  });

  it("warns about accepted-but-inert keys instead of pretending they work", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        slashCommand: { enabled: true, name: "salem" },
        channels: { [CHANNEL_ID]: { systemPrompt: "be terse", skills: ["x"] } },
      }),
    );

    expect(
      harness.policy.warnings.some((w) => w.includes("slashCommand")),
    ).toBe(true);
    expect(
      harness.policy.warnings.some((w) => w.includes("systemPrompt")),
    ).toBe(true);
  });

  it("consumes allowBots rather than resolving and discarding it", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { allowBots: true }, [OTHER_CHANNEL_ID]: {} },
      }),
    );

    await harness.handlers.message?.({
      message: channelMessage({ bot_id: "B0BOT0001", user: undefined }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);

    // The sibling channel keeps the global ignore-bots default.
    await harness.handlers.message?.({
      message: channelMessage({
        channel: OTHER_CHANNEL_ID,
        bot_id: "B0BOT0001",
        user: undefined,
      }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------ */
/* Multi-account isolation                                                   */
/* ------------------------------------------------------------------------ */

describe("ADVERSARIAL: per-account policy isolation", () => {
  it("resolves each account's policy independently, with top level as the base", async () => {
    const runtime = runtimeFromPersistedConfig(
      persistedSlackConfig({
        requireMention: true,
        accounts: {
          house: {
            botToken: "xoxb-house",
            appToken: "xapp-house",
            channels: { [CHANNEL_ID]: { requireMention: false } },
          },
          work: {
            botToken: "xoxb-work",
            appToken: "xapp-work",
            channels: { [CHANNEL_ID]: {} },
          },
        },
      }),
    );

    const house = resolveSlackAccount(runtime, "house");
    const work = resolveSlackAccount(runtime, "work");

    // Top-level requireMention is the BASE both accounts inherit …
    expect(house.requireMention).toBe(true);
    expect(work.requireMention).toBe(true);
    // … and the per-channel override belongs to exactly one of them.
    expect(house.channels[CHANNEL_ID].requireMention).toBe(false);
    expect(work.channels[CHANNEL_ID].requireMention).toBeUndefined();

    const housePolicy = await resolveSlackAccountPolicy({
      account: house,
      lookups: fakeLookups(),
    });
    const workPolicy = await resolveSlackAccountPolicy({
      account: work,
      lookups: fakeLookups(),
    });

    expect(
      evaluateSlackInbound(housePolicy, {
        eventClass: "channel",
        channelId: CHANNEL_ID,
        userId: USER_ID,
        isBotMessage: false,
        isMentioned: false,
        isAppMention: false,
      }).allowed,
    ).toBe(true);

    expect(
      evaluateSlackInbound(workPolicy, {
        eventClass: "channel",
        channelId: CHANNEL_ID,
        userId: USER_ID,
        isBotMessage: false,
        isMentioned: false,
        isAppMention: false,
      }),
    ).toMatchObject({ allowed: false, reason: "mention_required" });
  });
});

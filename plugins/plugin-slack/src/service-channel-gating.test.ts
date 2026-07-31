/**
 * Inbound gating tests for `SlackService` — the production-path proof for
 * per-channel `channels.slack.channels[<id>]` config.
 *
 * These drive the REAL handlers registered on the bolt app in
 * `registerEventHandlers` (`app.message` → `handleMessage`, `app.event
 * ("app_mention")` → `handleAppMention`), reached from a REAL persisted
 * `ElizaConfig` through the REAL character projection and account resolution
 * (see `./test-harness`). The previous revision of this file hand-constructed
 * `ResolvedSlackAccount`, which bypassed both upstream paths and is exactly how
 * a gate receiving no configuration at all passed its own suite.
 *
 * The adversarial regressions for each reviewed blocker live in
 * `./policy-adversarial.test.ts`; this file covers the ordinary contract and
 * the negative controls that keep the gate from degenerating into deny-all.
 */
import { describe, expect, it } from "vitest";
import {
  appMentionEvent,
  bootHarness,
  CHANNEL_ID,
  channelMessage,
  DM_CHANNEL_ID,
  OTHER_CHANNEL_ID,
  OTHER_USER_ID,
  persistedSlackConfig,
  USER_ID,
} from "./test-harness";

describe("SlackService inbound gating — per-channel requireMention", () => {
  it("registers handlers on the real bolt message and app_mention events", async () => {
    const harness = await bootHarness(persistedSlackConfig({}));
    expect(harness.handlers.message).toBeTypeOf("function");
    expect(harness.handlers.appMention).toBeTypeOf("function");
  });

  it("drops an unmentioned message when the channel sets requireMention:true", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { requireMention: true } },
      }),
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("processes an unmentioned message when the channel sets requireMention:false", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { requireMention: false } },
      }),
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("lets a per-channel requireMention:false override the global mention-only flag", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { requireMention: false } },
      }),
      { globalRequireMention: true },
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("lets a per-channel requireMention:true override a permissive global default", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: {
          [CHANNEL_ID]: { requireMention: true },
          [OTHER_CHANNEL_ID]: { requireMention: false },
        },
      }),
      { globalRequireMention: false },
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();

    // The sibling channel opted out, so it still replies unmentioned.
    await harness.handlers.message?.({
      message: channelMessage({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("honours the account-level requireMention when the channel is silent", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        requireMention: true,
        channels: { [CHANNEL_ID]: {} },
      }),
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("still honours the global env flag when no structured config exists", async () => {
    const harness = await bootHarness(persistedSlackConfig({}), {
      globalRequireMention: true,
    });

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("resolves requireMention through a name-keyed entry, bound at startup", async () => {
    // CONTRACT CHANGE vs the reviewed head: a name key is resolved to its
    // immutable id during startup, so it applies to the FIRST event. It used
    // to depend on the channel cache being warm, which is precisely the
    // cold-cache bypass the review reproduced.
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { general: { requireMention: true } } }),
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("applies the wildcard entry to an otherwise unconfigured channel", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { "*": { requireMention: true } } }),
    );

    await harness.handlers.message?.({
      message: channelMessage({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });
});

describe("SlackService inbound gating — structured channels as an allowlist source", () => {
  it("admits a channel that only the structured config names", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { [CHANNEL_ID]: {} } }),
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a channel absent from the structured allowlist", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { [CHANNEL_ID]: {} } }),
    );

    await harness.handlers.message?.({
      message: channelMessage({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("drops an explicitly disabled channel even when it was dynamically joined", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        groupPolicy: "open",
        channels: { [CHANNEL_ID]: { enabled: false } },
      }),
    );

    await harness.handlers.memberJoined?.({
      event: { user: "U0BOTBOT0", channel: CHANNEL_ID },
    });

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("keeps replying everywhere when nothing is configured at all", async () => {
    // NEGATIVE CONTROL: the gate must not degenerate into deny-all for the
    // legacy env-only deployments that never wrote a policy.
    const harness = await bootHarness(persistedSlackConfig({}));

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);

    await harness.handlers.message?.({
      message: channelMessage({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(2);
  });

  it("unions the SLACK_CHANNEL_IDS env allowlist with the structured one", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { [CHANNEL_ID]: {} } }),
      { envAllowedChannelIds: [OTHER_CHANNEL_ID] },
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    await harness.handlers.message?.({
      message: channelMessage({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(2);

    await harness.handlers.message?.({
      message: channelMessage({ channel: "C0THIRD000" }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(2);
  });
});

describe("SlackService inbound gating — per-channel user allowlist", () => {
  it("drops a message from a user outside the channel users list", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { users: [USER_ID] } },
      }),
    );

    await harness.handlers.message?.({
      message: channelMessage({ user: OTHER_USER_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("processes a message from a user inside the channel users list", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { users: [USER_ID] } },
      }),
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("accepts Slack mention syntax in the allowlist", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { users: [`<@${USER_ID}|salem>`] } },
      }),
    );

    await harness.handlers.message?.({ message: channelMessage(), client: {} });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("treats a '*' entry as allow-all", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { [CHANNEL_ID]: { users: ["*"] } } }),
    );

    await harness.handlers.message?.({
      message: channelMessage({ user: OTHER_USER_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });
});

describe("SlackService inbound gating — app_mention path", () => {
  it("still answers an @mention in a channel that requires mentions", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { requireMention: true } },
      }),
    );

    await harness.handlers.appMention?.({
      event: appMentionEvent(),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("drops an @mention in an explicitly disabled channel", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { enabled: false }, [OTHER_CHANNEL_ID]: {} },
      }),
    );

    await harness.handlers.appMention?.({
      event: appMentionEvent(),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("drops an @mention from a user outside the channel users list", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({
        channels: { [CHANNEL_ID]: { users: [USER_ID] } },
      }),
    );

    await harness.handlers.appMention?.({
      event: appMentionEvent({ user: OTHER_USER_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("drops an @mention in a channel outside the structured allowlist", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { [CHANNEL_ID]: {} } }),
    );

    await harness.handlers.appMention?.({
      event: appMentionEvent({ channel: OTHER_CHANNEL_ID }),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });

  it("does not double-process a mention through the message handler", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { [CHANNEL_ID]: {} } }),
    );

    await harness.handlers.message?.({
      message: channelMessage({ text: "<@U0BOTBOT0> status?" }),
      client: {},
    });
    expect(harness.processAgentMessage).not.toHaveBeenCalled();
  });
});

describe("SlackService inbound gating — DM traffic obeys DM policy, not channel policy", () => {
  it("processes a DM even when a wildcard channel entry requires mentions", async () => {
    const harness = await bootHarness(
      persistedSlackConfig({ channels: { "*": { requireMention: true } } }),
    );

    await harness.handlers.message?.({
      message: channelMessage({ channel: DM_CHANNEL_ID, channel_type: "im" }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("processes a mentioned DM through the message handler", async () => {
    // Direct surfaces receive no app_mention event, so the message handler
    // must keep them even when the text carries the bot mention.
    const harness = await bootHarness(persistedSlackConfig({}));

    await harness.handlers.message?.({
      message: channelMessage({
        channel: DM_CHANNEL_ID,
        channel_type: "im",
        text: "<@U0BOTBOT0> hi",
      }),
      client: {},
    });
    expect(harness.processAgentMessage).toHaveBeenCalledTimes(1);
  });
});

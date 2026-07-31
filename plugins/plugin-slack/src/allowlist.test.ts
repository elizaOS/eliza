/**
 * Unit tests for the Slack per-channel config resolver.
 *
 * These cover `allowlist.ts` in isolation (pure functions, no runtime); the
 * service-level proof that the resolver is actually consulted on the inbound
 * path lives in `service-channel-gating.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  collectSlackConfiguredChannelIds,
  isSlackChannelIdKey,
  normalizeSlackAllowList,
  normalizeSlackSlug,
  resolveSlackChannelConfig,
  resolveSlackInboundGate,
  resolveSlackShouldRequireMention,
  resolveSlackUserAllowed,
  slackAllowListMatches,
} from "./allowlist";

describe("normalizeSlackSlug", () => {
  it("strips a leading # and lowercases", () => {
    expect(normalizeSlackSlug("#General")).toBe("general");
  });

  it("collapses non-alphanumerics into single dashes", () => {
    expect(normalizeSlackSlug("House  Chores!")).toBe("house-chores");
  });

  it("trims leading and trailing dashes", () => {
    expect(normalizeSlackSlug("--chores--")).toBe("chores");
  });
});

describe("isSlackChannelIdKey", () => {
  it("accepts C/G/D-prefixed Slack ids", () => {
    expect(isSlackChannelIdKey("C0123ABCD")).toBe(true);
    expect(isSlackChannelIdKey("G0123ABCD")).toBe(true);
    expect(isSlackChannelIdKey("D0123ABCD")).toBe(true);
  });

  it("rejects human channel names and the wildcard", () => {
    expect(isSlackChannelIdKey("general")).toBe(false);
    expect(isSlackChannelIdKey("*")).toBe(false);
    expect(isSlackChannelIdKey("C123")).toBe(false);
  });
});

describe("normalizeSlackAllowList", () => {
  it("returns null for an absent or empty list so callers default to allow", () => {
    expect(normalizeSlackAllowList(undefined)).toBeNull();
    expect(normalizeSlackAllowList([])).toBeNull();
  });

  it("detects the allow-all wildcard", () => {
    expect(normalizeSlackAllowList(["*"])?.allowAll).toBe(true);
  });

  it("unwraps Slack mention syntax into bare ids", () => {
    const list = normalizeSlackAllowList(["<@U0123ABCD>"]);
    expect(list?.ids.has("U0123ABCD")).toBe(true);
  });

  it("unwraps mention syntax carrying a display name", () => {
    const list = normalizeSlackAllowList(["<@U0123ABCD|salem>"]);
    expect(list?.ids.has("U0123ABCD")).toBe(true);
  });

  it("strips slack:/user: prefixes and classifies ids vs handles", () => {
    const list = normalizeSlackAllowList(["slack:U0123ABCD", "user:shadow"]);
    expect(list?.ids.has("U0123ABCD")).toBe(true);
    expect(list?.names.has("shadow")).toBe(true);
  });

  it("treats bare non-id entries as name slugs", () => {
    const list = normalizeSlackAllowList(["Shadow Ben"]);
    expect(list?.names.has("shadow-ben")).toBe(true);
  });
});

describe("slackAllowListMatches", () => {
  function buildList() {
    const list = normalizeSlackAllowList(["U0123ABCD", "shadow"]);
    if (!list) throw new Error("expected a normalized allowlist");
    return list;
  }

  it("matches by id case-insensitively", () => {
    expect(slackAllowListMatches(buildList(), { id: "u0123abcd" })).toBe(true);
  });

  it("matches by display name slug", () => {
    expect(
      slackAllowListMatches(buildList(), { id: "UZZZZZZZZ", name: "Shadow" }),
    ).toBe(true);
  });

  it("rejects an unlisted user", () => {
    expect(
      slackAllowListMatches(buildList(), { id: "UZZZZZZZZ", name: "stranger" }),
    ).toBe(false);
  });
});

describe("resolveSlackUserAllowed", () => {
  it("allows everyone when no allowlist is configured", () => {
    expect(resolveSlackUserAllowed({ userId: "UANY00000" })).toBe(true);
  });

  it("enforces the allowlist when one is configured", () => {
    expect(
      resolveSlackUserAllowed({
        allowList: ["U0123ABCD"],
        userId: "UOTHER123",
      }),
    ).toBe(false);
  });
});

describe("resolveSlackChannelConfig", () => {
  it("returns null when no channels record is configured", () => {
    expect(
      resolveSlackChannelConfig({
        channels: undefined,
        channelId: "C0123ABCD",
      }),
    ).toBeNull();
  });

  it("returns null when the record has no entry for the channel", () => {
    expect(
      resolveSlackChannelConfig({
        channels: { C0000AAAA: { requireMention: true } },
        channelId: "C0123ABCD",
      }),
    ).toBeNull();
  });

  it("matches by exact channel id", () => {
    const resolved = resolveSlackChannelConfig({
      channels: { C0123ABCD: { requireMention: true } },
      channelId: "C0123ABCD",
    });
    expect(resolved).toMatchObject({
      allowed: true,
      requireMention: true,
      matchSource: "id",
      matchKey: "C0123ABCD",
    });
  });

  it("matches by channel-name slug when the name is known", () => {
    const resolved = resolveSlackChannelConfig({
      channels: { "house-chores": { requireMention: false } },
      channelId: "C0123ABCD",
      channelName: "House Chores",
    });
    expect(resolved).toMatchObject({
      requireMention: false,
      matchSource: "name",
    });
  });

  it("does not match by name when the name is unknown", () => {
    expect(
      resolveSlackChannelConfig({
        channels: { general: { requireMention: false } },
        channelId: "C0123ABCD",
      }),
    ).toBeNull();
  });

  it("falls back to the wildcard entry", () => {
    const resolved = resolveSlackChannelConfig({
      channels: { "*": { requireMention: true } },
      channelId: "C0123ABCD",
    });
    expect(resolved).toMatchObject({
      requireMention: true,
      matchSource: "wildcard",
    });
  });

  it("prefers an exact id entry over the wildcard", () => {
    const resolved = resolveSlackChannelConfig({
      channels: {
        "*": { requireMention: true },
        C0123ABCD: { requireMention: false },
      },
      channelId: "C0123ABCD",
    });
    expect(resolved).toMatchObject({
      requireMention: false,
      matchSource: "id",
    });
  });

  it("marks a channel disallowed via enabled:false", () => {
    const resolved = resolveSlackChannelConfig({
      channels: { C0123ABCD: { enabled: false } },
      channelId: "C0123ABCD",
    });
    expect(resolved?.allowed).toBe(false);
  });

  it("marks a channel disallowed via the legacy allow:false alias", () => {
    const resolved = resolveSlackChannelConfig({
      channels: { C0123ABCD: { allow: false } },
      channelId: "C0123ABCD",
    });
    expect(resolved?.allowed).toBe(false);
  });

  it("surfaces skills and systemPrompt for the follow-up slice", () => {
    const resolved = resolveSlackChannelConfig({
      channels: {
        C0123ABCD: { skills: ["chores"], systemPrompt: "You run the house." },
      },
      channelId: "C0123ABCD",
    });
    expect(resolved?.skills).toEqual(["chores"]);
    expect(resolved?.systemPrompt).toBe("You run the house.");
  });
});

describe("collectSlackConfiguredChannelIds", () => {
  it("returns id-shaped keys as allowlist entries", () => {
    expect(
      collectSlackConfiguredChannelIds({
        C0123ABCD: { requireMention: true },
      }),
    ).toEqual(["C0123ABCD"]);
  });

  it("ignores name-keyed and wildcard entries", () => {
    expect(
      collectSlackConfiguredChannelIds({
        general: {},
        "*": {},
      }),
    ).toEqual([]);
  });

  it("excludes explicitly disabled channels", () => {
    expect(
      collectSlackConfiguredChannelIds({
        C0123ABCD: { enabled: false },
        C0999ZZZZ: { allow: false },
        C0777YYYY: {},
      }),
    ).toEqual(["C0777YYYY"]);
  });
});

describe("resolveSlackShouldRequireMention", () => {
  it("prefers the per-channel value over account and global", () => {
    expect(
      resolveSlackShouldRequireMention({
        channelConfig: { allowed: true, requireMention: true },
        accountRequireMention: false,
        globalRequireMention: false,
      }),
    ).toBe(true);
  });

  it("lets a per-channel false override a global true", () => {
    expect(
      resolveSlackShouldRequireMention({
        channelConfig: { allowed: true, requireMention: false },
        globalRequireMention: true,
      }),
    ).toBe(false);
  });

  it("falls back to the account value when the channel is silent", () => {
    expect(
      resolveSlackShouldRequireMention({
        channelConfig: { allowed: true },
        accountRequireMention: true,
        globalRequireMention: false,
      }),
    ).toBe(true);
  });

  it("falls back to the global env flag when channel and account are silent", () => {
    expect(
      resolveSlackShouldRequireMention({ globalRequireMention: true }),
    ).toBe(true);
  });

  it("defaults to false so env-only deployments keep replying", () => {
    expect(resolveSlackShouldRequireMention({})).toBe(false);
  });
});

describe("resolveSlackInboundGate", () => {
  it("denies an explicitly disabled channel even when otherwise allowed", () => {
    const gate = resolveSlackInboundGate({
      channelConfig: { allowed: false },
      isChannelAllowed: true,
      isMentioned: true,
    });
    expect(gate).toEqual({ allowed: false, reason: "channel_disabled" });
  });

  it("denies a channel outside the allowlist", () => {
    const gate = resolveSlackInboundGate({
      isChannelAllowed: false,
      isMentioned: true,
    });
    expect(gate).toEqual({ allowed: false, reason: "channel_not_allowed" });
  });

  it("denies an unmentioned message when the channel requires a mention", () => {
    const gate = resolveSlackInboundGate({
      channelConfig: { allowed: true, requireMention: true },
      isChannelAllowed: true,
      isMentioned: false,
    });
    expect(gate).toEqual({ allowed: false, reason: "mention_required" });
  });

  it("allows an unmentioned message when the channel opts out of mention gating", () => {
    const gate = resolveSlackInboundGate({
      channelConfig: { allowed: true, requireMention: false },
      isChannelAllowed: true,
      isMentioned: false,
      globalRequireMention: true,
    });
    expect(gate.allowed).toBe(true);
  });

  it("denies a user outside the per-channel user allowlist", () => {
    const gate = resolveSlackInboundGate({
      channelConfig: { allowed: true, users: ["U0123ABCD"] },
      isChannelAllowed: true,
      isMentioned: true,
      userId: "UOTHER123",
    });
    expect(gate).toEqual({ allowed: false, reason: "user_not_allowed" });
  });

  it("allows a user inside the per-channel user allowlist", () => {
    const gate = resolveSlackInboundGate({
      channelConfig: { allowed: true, users: ["U0123ABCD"] },
      isChannelAllowed: true,
      isMentioned: true,
      userId: "U0123ABCD",
    });
    expect(gate.allowed).toBe(true);
  });

  it("skips the mention check for app_mention events", () => {
    const gate = resolveSlackInboundGate({
      channelConfig: { allowed: true, requireMention: true },
      isChannelAllowed: true,
      isMentioned: false,
      skipMentionCheck: true,
    });
    expect(gate.allowed).toBe(true);
  });
});

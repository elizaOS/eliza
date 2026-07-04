/**
 * Exercises pure per-channel deep-link URL construction for cross-channel
 * inbox triage. The cases pin platform-specific identifiers so queue entries
 * can link back to Discord, Telegram, Signal, iMessage, WhatsApp, Slack, Gmail,
 * and other source threads without dispatching connector calls.
 */
import { describe, expect, it } from "vitest";
import { buildDeepLink, resolveChannelName } from "./channel-deep-links.js";

describe("buildDeepLink — Discord", () => {
  it("builds a guild channel link, with optional message", () => {
    expect(
      buildDeepLink("discord", {
        roomMeta: { channelId: "C1" },
        worldMeta: { serverId: "S1" },
      }),
    ).toBe("https://discord.com/channels/S1/C1");
    expect(
      buildDeepLink("discord", {
        roomMeta: { channelId: "C1" },
        worldMeta: { serverId: "S1" },
        messageId: "M1",
      }),
    ).toBe("https://discord.com/channels/S1/C1/M1");
  });

  it("falls back to a DM (@me) link without a server, and null without a channel", () => {
    expect(
      buildDeepLink("discord-local", { roomMeta: { channelId: "C1" } }),
    ).toBe("https://discord.com/channels/@me/C1");
    expect(buildDeepLink("discord", { roomMeta: {} })).toBeNull();
  });
});

describe("buildDeepLink — Telegram", () => {
  it("prefers a public username", () => {
    expect(buildDeepLink("telegram", { roomMeta: { username: "chan" } })).toBe(
      "https://t.me/chan",
    );
    expect(
      buildDeepLink("telegram", {
        roomMeta: { username: "chan" },
        messageId: "9",
      }),
    ).toBe("https://t.me/chan/9");
  });

  it("uses a private c/ link for a chatId, stripping the -100 prefix", () => {
    expect(
      buildDeepLink("telegram-account", { roomMeta: { chatId: "-100123" } }),
    ).toBe("https://t.me/c/123");
    expect(buildDeepLink("telegram", { roomMeta: {} })).toBeNull();
  });
});

describe("buildDeepLink — Signal / iMessage / WhatsApp", () => {
  it("signal uses phoneNumber or identifier", () => {
    expect(
      buildDeepLink("signal", { roomMeta: { phoneNumber: "+15551234" } }),
    ).toBe("signal://signal.me/#p/+15551234");
    expect(buildDeepLink("signal", { roomMeta: { identifier: "+1999" } })).toBe(
      "signal://signal.me/#p/+1999",
    );
    expect(buildDeepLink("signal", { roomMeta: {} })).toBeNull();
  });

  it("imessage accepts handle / chatIdentifier / chat_identifier", () => {
    expect(buildDeepLink("imessage", { roomMeta: { handle: "a@b.com" } })).toBe(
      "imessage://a@b.com",
    );
    expect(
      buildDeepLink("imessage", { roomMeta: { chat_identifier: "+1555" } }),
    ).toBe("imessage://+1555");
  });

  it("whatsapp strips non-digits and the jid suffix", () => {
    expect(
      buildDeepLink("whatsapp", { roomMeta: { phoneNumber: "+1 (555) 12" } }),
    ).toBe("https://wa.me/155512");
    expect(
      buildDeepLink("whatsapp", {
        roomMeta: { jid: "15551234@s.whatsapp.net" },
      }),
    ).toBe("https://wa.me/15551234");
    expect(buildDeepLink("whatsapp", { roomMeta: {} })).toBeNull();
  });
});

describe("buildDeepLink — Slack", () => {
  it("builds a channel link, and a thread link with a normalized ts", () => {
    expect(
      buildDeepLink("slack", {
        roomMeta: { channelId: "C1" },
        worldMeta: { teamId: "T1" },
      }),
    ).toBe("slack://channel?team=T1&id=C1");
    expect(
      buildDeepLink("slack", {
        roomMeta: { channelId: "C1" },
        worldMeta: { teamId: "T1" },
        messageId: "p1700000000000100",
      }),
    ).toBe("https://app.slack.com/client/T1/C1/thread/C1-1700000000000100");
  });

  it("returns null without both team and channel", () => {
    expect(
      buildDeepLink("slack", { roomMeta: { channelId: "C1" } }),
    ).toBeNull();
    expect(buildDeepLink("slack", { worldMeta: { teamId: "T1" } })).toBeNull();
  });
});

describe("buildDeepLink — Gmail + dispatch", () => {
  it("builds a Gmail link with an encoded account, defaulting to 0", () => {
    expect(
      buildDeepLink("gmail", {
        roomMeta: { gmailAccountEmail: "me@x.com" },
        messageId: "abc",
      }),
    ).toBe("https://mail.google.com/mail/u/me%40x.com/#inbox/abc");
    expect(buildDeepLink("gmail", { roomMeta: { gmailMessageId: "z" } })).toBe(
      "https://mail.google.com/mail/u/0/#inbox/z",
    );
    expect(buildDeepLink("gmail", { roomMeta: {} })).toBeNull();
  });

  it("returns null for an unknown source", () => {
    expect(
      buildDeepLink("myspace", { roomMeta: { channelId: "C1" } }),
    ).toBeNull();
  });

  it("coerces numeric meta values to strings", () => {
    expect(buildDeepLink("telegram", { roomMeta: { username: 12345 } })).toBe(
      "https://t.me/12345",
    );
  });
});

describe("resolveChannelName", () => {
  it("prefers room name, then sender(source), then source", () => {
    expect(resolveChannelName("discord", "general")).toBe("general");
    expect(resolveChannelName("discord", undefined, "Alice")).toBe(
      "Alice (discord)",
    );
    expect(resolveChannelName("discord")).toBe("discord");
  });
});

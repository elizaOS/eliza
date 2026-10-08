/**
 * Exercises pure per-channel deep-link URL construction for cross-channel
 * inbox triage. The cases pin platform-specific identifiers so queue entries
 * can link back to Discord, Telegram, iMessage, WhatsApp, Slack, Gmail,
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
    expect(
      buildDeepLink("telegram-account", { roomMeta: { chatId: "-100" } }),
    ).toBeNull();
    expect(buildDeepLink("telegram", { roomMeta: {} })).toBeNull();
  });

  it("derives the c/ chat id from Room.channelId, the only id telegram persists", () => {
    // plugin-telegram ensureConnection stamps Room.channelId = <chat.id> and no
    // username/chatId room metadata, so the fetcher's overlay is the sole
    // carrier of the platform chat id.
    expect(
      buildDeepLink("telegram", {
        roomMeta: { channelId: "-1001234567890" },
        messageId: "42",
      }),
    ).toBe("https://t.me/c/1234567890/42");
    expect(
      buildDeepLink("telegram", { roomMeta: { channelId: "-1001234567890" } }),
    ).toBe("https://t.me/c/1234567890");
    // A forum-topic room id keeps the topic suffix; the link stays on the chat.
    expect(
      buildDeepLink("telegram", {
        roomMeta: { channelId: "-1001234567890-45" },
        messageId: "42",
      }),
    ).toBe("https://t.me/c/1234567890/42");
    // DM ids (positive) and basic-group ids (negative without -100) have no
    // public t.me/c form — fail closed instead of fabricating a dead link.
    expect(
      buildDeepLink("telegram", {
        roomMeta: { channelId: "987654321" },
        messageId: "7",
      }),
    ).toBeNull();
    expect(
      buildDeepLink("telegram", {
        roomMeta: { channelId: "-456789" },
        messageId: "9",
      }),
    ).toBeNull();
    // Another connector's channel id must never be read as a telegram chat.
    expect(
      buildDeepLink("telegram", {
        roomMeta: { channelId: "C0123ABCDE" },
        messageId: "1",
      }),
    ).toBeNull();
    // An explicit non-supergroup chatId metadata copy fails closed the same way.
    expect(
      buildDeepLink("telegram", { roomMeta: { chatId: "987654321" } }),
    ).toBeNull();
  });
});

describe("buildDeepLink — iMessage / WhatsApp", () => {
  it("imessage accepts handle / chatIdentifier / chat_identifier", () => {
    expect(buildDeepLink("imessage", { roomMeta: { handle: "a@b.com" } })).toBe(
      "imessage://a@b.com",
    );
    expect(
      buildDeepLink("imessage", { roomMeta: { chat_identifier: "+1555" } }),
    ).toBe("imessage://+1555");
  });

  it("opens a 1:1 chat from the chatId and channelId imessage persists", () => {
    // plugin-imessage ensureRoomExists stores chat.db chat_identifier as
    // metadata.chatId and Room.channelId. Direct chats are a phone/email,
    // sometimes wrapped as "<service>;-;<address>".
    expect(
      buildDeepLink("imessage", {
        roomMeta: {
          accountId: "default",
          chatId: "iMessage;-;+15551234567",
          chatType: "direct",
          channelId: "iMessage;-;+15551234567",
        },
      }),
    ).toBe("imessage://+15551234567");
    expect(
      buildDeepLink("imessage", {
        roomMeta: { channelId: "person@icloud.com" },
      }),
    ).toBe("imessage://person@icloud.com");
    expect(
      buildDeepLink("imessage", { roomMeta: { chatId: "+15551234567" } }),
    ).toBe("imessage://+15551234567");
    // Group ids have no public imessage:// form.
    expect(
      buildDeepLink("imessage", {
        roomMeta: {
          chatId: "iMessage;+;chat123",
          channelId: "iMessage;+;chat123",
          chatType: "group",
        },
      }),
    ).toBeNull();
    expect(
      buildDeepLink("imessage", { roomMeta: { chatId: "chat839201928374" } }),
    ).toBeNull();
    expect(buildDeepLink("imessage", { roomMeta: {} })).toBeNull();
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
    expect(
      buildDeepLink("whatsapp", { roomMeta: { phoneNumber: "non-digits" } }),
    ).toBeNull();
    expect(
      buildDeepLink("whatsapp", { roomMeta: { jid: "@s.whatsapp.net" } }),
    ).toBeNull();
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
    ).toBe("https://app.slack.com/client/T1/C1/thread/C1-1700000000.000100");
    expect(
      buildDeepLink("slack", {
        roomMeta: { channelId: "C1" },
        worldMeta: { teamId: "T1" },
        messageId: "1700000000.000100",
      }),
    ).toBe("https://app.slack.com/client/T1/C1/thread/C1-1700000000.000100");
  });

  it("returns null without both team and channel", () => {
    expect(
      buildDeepLink("slack", { roomMeta: { channelId: "C1" } }),
    ).toBeNull();
    expect(buildDeepLink("slack", { worldMeta: { teamId: "T1" } })).toBeNull();
  });

  it("resolves the workspace from the room metadata serverId slack stamps", () => {
    // plugin-slack ensureRoomExists persists the team id only as room metadata
    // `serverId` (and nested under `slack`); the workspace world nests it under
    // `extra.teamId`. Neither top-level key exists in production rooms.
    const roomMeta = {
      channelId: "C0123",
      serverId: "T0456",
      slack: { teamId: "T0456", channelId: "C0123" },
    };
    expect(
      buildDeepLink("slack", {
        roomMeta,
        worldMeta: { extra: { teamId: "T0456" } },
      }),
    ).toBe("slack://channel?team=T0456&id=C0123");
    expect(
      buildDeepLink("slack", {
        roomMeta,
        worldMeta: { extra: { teamId: "T0456" } },
        messageId: "1700000000.000100",
      }),
    ).toBe(
      "https://app.slack.com/client/T0456/C0123/thread/C0123-1700000000.000100",
    );
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

it.each(["120363000000@g.us", "123456789@lid", "status@broadcast"])(
  "does not invent a direct phone link for WhatsApp %s despite phone metadata",
  (jid) => {
    expect(
      buildDeepLink("whatsapp", {
        roomMeta: { jid, phoneNumber: "+15551234567" },
      }),
    ).toBeNull();
  },
);

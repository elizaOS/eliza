import { describe, expect, it } from "vitest";

import type { InboundMessage } from "../inbox/types.js";
import {
  buildUnifiedInbox,
  normalizeUnifiedInboxChannel,
  resolveUnifiedInboxRequest,
  toUnifiedInboxMessage,
} from "./service-mixin-unified-inbox.js";

describe("normalizeUnifiedInboxChannel", () => {
  it("maps a canonical channel name to itself", () => {
    expect(normalizeUnifiedInboxChannel("gmail")).toBe("gmail");
    expect(normalizeUnifiedInboxChannel("telegram")).toBe("telegram");
    expect(normalizeUnifiedInboxChannel("SMS")).toBe("sms");
  });

  it("rejects unknown sources", () => {
    expect(normalizeUnifiedInboxChannel("slack")).toBeNull();
    expect(normalizeUnifiedInboxChannel("")).toBeNull();
    expect(normalizeUnifiedInboxChannel(null)).toBeNull();
    expect(normalizeUnifiedInboxChannel(undefined)).toBeNull();
  });
});

describe("resolveUnifiedInboxRequest", () => {
  it("falls back to the default limit and all channels when omitted", () => {
    const { limit, allowed } = resolveUnifiedInboxRequest({});
    expect(limit).toBe(100);
    expect(allowed.has("gmail")).toBe(true);
    expect(allowed.has("telegram")).toBe(true);
    expect(allowed.has("sms")).toBe(true);
    expect(allowed.size).toBe(7);
  });

  it("clamps limit to the maximum of 500", () => {
    expect(resolveUnifiedInboxRequest({ limit: 9999 }).limit).toBe(500);
  });

  it("ignores non-positive or non-finite limits", () => {
    expect(resolveUnifiedInboxRequest({ limit: 0 }).limit).toBe(100);
    expect(resolveUnifiedInboxRequest({ limit: -5 }).limit).toBe(100);
    expect(resolveUnifiedInboxRequest({ limit: Number.NaN }).limit).toBe(100);
  });

  it("narrows the allow-list to the requested channels", () => {
    const { allowed } = resolveUnifiedInboxRequest({
      channels: ["gmail", "discord"],
    });
    expect(allowed.has("gmail")).toBe(true);
    expect(allowed.has("discord")).toBe(true);
    expect(allowed.has("telegram")).toBe(false);
    expect(allowed.size).toBe(2);
  });
});

describe("toUnifiedInboxMessage", () => {
  it("prefixes the id with the channel and preserves the external id", () => {
    const msg: InboundMessage = {
      id: "mem-1",
      source: "telegram",
      roomId: "room-1",
      entityId: "user-1",
      senderName: "Alice",
      channelName: "Alice",
      channelType: "dm",
      text: "pls ping",
      snippet: "pls ping",
      timestamp: Date.UTC(2025, 0, 1, 12, 0, 0),
      deepLink: "tg://resolve?domain=alice",
    };
    const out = toUnifiedInboxMessage(msg, "telegram", 0);
    expect(out.id).toBe("telegram:mem-1");
    expect(out.channel).toBe("telegram");
    expect(out.subject).toBeNull();
    expect(out.deepLink).toBe("tg://resolve?domain=alice");
    expect(out.sourceRef).toEqual({
      channel: "telegram",
      externalId: "mem-1",
    });
    expect(out.unread).toBe(true);
    expect(out.receivedAt).toBe("2025-01-01T12:00:00.000Z");
  });

  it("derives gmail subject from the channel name when present", () => {
    const msg: InboundMessage = {
      id: "gm-1",
      source: "gmail",
      senderName: "boss@corp.com",
      channelName: "Email from boss@corp.com",
      channelType: "dm",
      text: "Q3 plan",
      snippet: "Q3 plan",
      timestamp: Date.UTC(2025, 0, 1, 12, 0, 0),
      gmailMessageId: "gm-1-ext",
      gmailIsImportant: true,
      gmailLikelyReplyNeeded: true,
    };
    const out = toUnifiedInboxMessage(msg, "gmail", 0);
    expect(out.id).toBe("gmail:gm-1-ext");
    expect(out.subject).toBe("boss@corp.com");
    expect(out.unread).toBe(true);
    expect(out.sourceRef.externalId).toBe("gm-1-ext");
  });

  it("leaves gmail read when neither important nor reply-needed", () => {
    const msg: InboundMessage = {
      id: "gm-2",
      source: "gmail",
      senderName: "newsletter@news.com",
      channelName: "Email from newsletter@news.com",
      channelType: "dm",
      text: "Weekly digest",
      snippet: "Weekly digest",
      timestamp: Date.UTC(2025, 0, 1, 12, 0, 0),
      gmailMessageId: "gm-2-ext",
      gmailIsImportant: false,
      gmailLikelyReplyNeeded: false,
    };
    expect(toUnifiedInboxMessage(msg, "gmail", 0).unread).toBe(false);
  });
});

describe("buildUnifiedInbox", () => {
  const makeMessages = (): InboundMessage[] => [
    {
      id: "mem-tg",
      source: "telegram",
      roomId: "room-1",
      entityId: "user-1",
      senderName: "Alice",
      channelName: "Alice",
      channelType: "dm",
      text: "hi",
      snippet: "hi",
      timestamp: Date.UTC(2025, 0, 1, 12, 0, 0),
    },
    {
      id: "gm-1",
      source: "gmail",
      senderName: "boss@corp.com",
      channelName: "Email from boss@corp.com",
      channelType: "dm",
      text: "Q3 plan",
      snippet: "Q3 plan",
      timestamp: Date.UTC(2025, 0, 2, 9, 0, 0),
      gmailMessageId: "gm-1-ext",
      gmailIsImportant: true,
      gmailLikelyReplyNeeded: true,
    },
    {
      id: "mem-dc",
      source: "discord",
      roomId: "room-2",
      entityId: "user-2",
      senderName: "Bob",
      channelName: "Bob",
      channelType: "dm",
      text: "are you free?",
      snippet: "are you free?",
      timestamp: Date.UTC(2025, 0, 3, 18, 0, 0),
    },
  ];

  it("sorts messages newest-first and fills channel counts", () => {
    const allowed = new Set<
      ReturnType<typeof resolveUnifiedInboxRequest>["allowed"] extends Set<
        infer T
      >
        ? T
        : never
    >([
      "gmail",
      "discord",
      "telegram",
      "signal",
      "imessage",
      "whatsapp",
      "sms",
    ]);
    const inbox = buildUnifiedInbox(makeMessages(), { limit: 10, allowed });
    expect(inbox.messages.map((m) => m.channel)).toEqual([
      "discord",
      "gmail",
      "telegram",
    ]);
    expect(inbox.channelCounts.gmail).toEqual({ total: 1, unread: 1 });
    expect(inbox.channelCounts.telegram).toEqual({ total: 1, unread: 1 });
    expect(inbox.channelCounts.discord).toEqual({ total: 1, unread: 1 });
    expect(inbox.channelCounts.signal).toEqual({ total: 0, unread: 0 });
    expect(typeof inbox.fetchedAt).toBe("string");
    expect(Number.isFinite(Date.parse(inbox.fetchedAt))).toBe(true);
  });

  it("drops channels that are not in the allow-list", () => {
    const allowed = new Set(["gmail"] as const);
    const inbox = buildUnifiedInbox(makeMessages(), {
      limit: 10,
      allowed: allowed as unknown as Set<
        ReturnType<typeof resolveUnifiedInboxRequest>["allowed"] extends Set<
          infer T
        >
          ? T
          : never
      >,
    });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]?.channel).toBe("gmail");
    expect(inbox.channelCounts.gmail.total).toBe(1);
    expect(inbox.channelCounts.telegram.total).toBe(0);
    expect(inbox.channelCounts.discord.total).toBe(0);
  });

  it("caps the trimmed output at the requested limit", () => {
    const inbound: InboundMessage[] = Array.from({ length: 5 }, (_, i) => ({
      id: `mem-${i}`,
      source: "discord",
      roomId: `room-${i}`,
      entityId: `user-${i}`,
      senderName: "Bob",
      channelName: "Bob",
      channelType: "dm",
      text: `msg ${i}`,
      snippet: `msg ${i}`,
      timestamp: Date.UTC(2025, 0, 1, 0, i, 0),
    }));
    const allowed = new Set([
      "gmail",
      "discord",
      "telegram",
      "signal",
      "imessage",
      "whatsapp",
      "sms",
    ] as const);
    const inbox = buildUnifiedInbox(inbound, {
      limit: 2,
      allowed: allowed as unknown as Set<
        ReturnType<typeof resolveUnifiedInboxRequest>["allowed"] extends Set<
          infer T
        >
          ? T
          : never
      >,
    });
    expect(inbox.messages).toHaveLength(2);
    expect(inbox.channelCounts.discord.total).toBe(5);
  });

  it("ignores inbound entries with unknown source tags", () => {
    const allowed = new Set([
      "gmail",
      "discord",
      "telegram",
      "signal",
      "imessage",
      "whatsapp",
      "sms",
    ] as const);
    const inbox = buildUnifiedInbox(
      [
        {
          id: "mem-x",
          source: "random-other",
          senderName: "Nope",
          channelName: "Nope",
          channelType: "dm",
          text: "hi",
          snippet: "hi",
          timestamp: Date.UTC(2025, 0, 1, 12, 0, 0),
        },
      ],
      {
        limit: 10,
        allowed: allowed as unknown as Set<
          ReturnType<typeof resolveUnifiedInboxRequest>["allowed"] extends Set<
            infer T
          >
            ? T
            : never
        >,
      },
    );
    expect(inbox.messages).toHaveLength(0);
  });
});

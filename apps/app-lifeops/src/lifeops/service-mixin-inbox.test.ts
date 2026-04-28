import { describe, expect, it, vi } from "vitest";
import {
  LIFEOPS_INBOX_CHANNELS,
  type LifeOpsInboxMessage,
} from "@elizaos/shared";

import type { InboundMessage } from "../inbox/types.js";
import {
  buildInbox,
  buildInboxFromMessages,
  normalizeInboxChannel,
  resolveInboxRequest,
  toInboxMessage,
  toInboxMessages,
  withInbox,
} from "./service-mixin-inbox.js";
import type { LifeOpsCachedInboxMessage } from "./repository.js";

describe("normalizeInboxChannel", () => {
  it("maps a canonical channel name to itself", () => {
    expect(normalizeInboxChannel("gmail")).toBe("gmail");
    expect(normalizeInboxChannel("telegram")).toBe("telegram");
    expect(normalizeInboxChannel("SMS")).toBe("sms");
  });

  it("rejects unknown sources", () => {
    expect(normalizeInboxChannel("slack")).toBeNull();
    expect(normalizeInboxChannel("")).toBeNull();
    expect(normalizeInboxChannel(null)).toBeNull();
    expect(normalizeInboxChannel(undefined)).toBeNull();
  });
});

describe("resolveInboxRequest", () => {
  it("falls back to the default limit and all channels when omitted", () => {
    const { limit, allowed } = resolveInboxRequest({});
    expect(limit).toBe(100);
    expect(allowed.has("gmail")).toBe(true);
    expect(allowed.has("x_dm")).toBe(true);
    expect(allowed.has("telegram")).toBe(true);
    expect(allowed.has("sms")).toBe(true);
    expect(allowed.size).toBe(LIFEOPS_INBOX_CHANNELS.length);
  });

  it("clamps limit to the maximum of 500", () => {
    expect(resolveInboxRequest({ limit: 9999 }).limit).toBe(500);
  });

  it("ignores non-positive or non-finite limits", () => {
    expect(resolveInboxRequest({ limit: 0 }).limit).toBe(100);
    expect(resolveInboxRequest({ limit: -5 }).limit).toBe(100);
    expect(resolveInboxRequest({ limit: Number.NaN }).limit).toBe(100);
  });

  it("narrows the allow-list to the requested channels", () => {
    const { allowed } = resolveInboxRequest({
      channels: ["gmail", "discord"],
    });
    expect(allowed.has("gmail")).toBe(true);
    expect(allowed.has("discord")).toBe(true);
    expect(allowed.has("telegram")).toBe(false);
    expect(allowed.size).toBe(2);
  });

  it("keeps normal reads bounded but expands explicit full-cache modes", () => {
    expect(resolveInboxRequest({}).cacheMode).toBe("read-through");
    expect(resolveInboxRequest({}).cacheLimit).toBe(200);

    const refresh = resolveInboxRequest({
      cacheMode: "refresh",
      cacheLimit: 2500,
    });
    expect(refresh.cacheMode).toBe("refresh");
    expect(refresh.cacheLimit).toBe(2500);

    const cacheOnly = resolveInboxRequest({ cacheMode: "cache-only" });
    expect(cacheOnly.cacheMode).toBe("cache-only");
    expect(cacheOnly.cacheLimit).toBe(5000);
  });

  it("caps explicit cache warming to the bounded full-inbox window", () => {
    expect(
      resolveInboxRequest({ cacheMode: "refresh", cacheLimit: 50_000 })
        .cacheLimit,
    ).toBe(5000);
  });
});

describe("toInboxMessage", () => {
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
    const out = toInboxMessage(msg, "telegram", 0);
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
    const out = toInboxMessage(msg, "gmail", 0);
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
    expect(toInboxMessage(msg, "gmail", 0).unread).toBe(false);
  });

  it("preserves priority retrieval metadata on normalized messages", () => {
    const msg: InboundMessage = {
      id: "mem-priority",
      source: "telegram",
      roomId: "room-priority",
      entityId: "user-priority",
      senderName: "Alice",
      channelName: "Alice",
      channelType: "dm",
      text: "please review",
      snippet: "please review",
      timestamp: Date.UTC(2025, 0, 1, 12, 0, 0),
      lastSeenAt: "2025-01-01T13:00:00.000Z",
      repliedAt: "2025-01-01T14:00:00.000Z",
      priorityScore: 88,
    };
    const out = toInboxMessage(msg, "telegram", 0);
    expect(out.lastSeenAt).toBe("2025-01-01T13:00:00.000Z");
    expect(out.repliedAt).toBe("2025-01-01T14:00:00.000Z");
    expect(out.priorityScore).toBe(88);
  });
});

describe("toInboxMessages", () => {
  it("normalizes every supported inbound message for cache warming", () => {
    const out = toInboxMessages([
      {
        id: "mem-1",
        source: "discord",
        roomId: "room-1",
        senderName: "Alice",
        channelName: "Alice",
        channelType: "dm",
        text: "hi",
        snippet: "hi",
        timestamp: 1,
      },
      {
        id: "mem-2",
        source: "slack",
        roomId: "room-2",
        senderName: "Ignored",
        channelName: "Ignored",
        channelType: "dm",
        text: "ignored",
        snippet: "ignored",
        timestamp: 2,
      },
    ]);

    expect(out.map((message) => message.id)).toEqual(["discord:mem-1"]);
  });
});

describe("buildInbox", () => {
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
      ReturnType<typeof resolveInboxRequest>["allowed"] extends Set<infer T>
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
    const inbox = buildInbox(makeMessages(), { limit: 10, allowed });
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
    const inbox = buildInbox(makeMessages(), {
      limit: 10,
      allowed: allowed as unknown as Set<
        ReturnType<typeof resolveInboxRequest>["allowed"] extends Set<infer T>
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
    const inbox = buildInbox(inbound, {
      limit: 2,
      allowed: allowed as unknown as Set<
        ReturnType<typeof resolveInboxRequest>["allowed"] extends Set<infer T>
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
    const inbox = buildInbox(
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
          ReturnType<typeof resolveInboxRequest>["allowed"] extends Set<infer T>
            ? T
            : never
        >,
      },
    );
    expect(inbox.messages).toHaveLength(0);
  });
});

describe("buildInboxFromMessages", () => {
  it("builds the same inbox shape from cached normalized messages", () => {
    const allowed = new Set(["discord"] as const);
    const cached: LifeOpsInboxMessage[] = [
      {
        id: "discord:mem-old",
        channel: "discord",
        sender: {
          id: "u1",
          displayName: "Alice",
          email: null,
          avatarUrl: null,
        },
        subject: null,
        snippet: "first",
        receivedAt: "2025-01-01T09:00:00.000Z",
        unread: true,
        deepLink: null,
        sourceRef: { channel: "discord", externalId: "mem-old" },
        threadId: "room-1",
        chatType: "dm",
      },
      {
        id: "discord:mem-new",
        channel: "discord",
        sender: {
          id: "u1",
          displayName: "Alice",
          email: null,
          avatarUrl: null,
        },
        subject: null,
        snippet: "later",
        receivedAt: "2025-01-01T10:00:00.000Z",
        unread: true,
        deepLink: null,
        sourceRef: { channel: "discord", externalId: "mem-new" },
        threadId: "room-1",
        chatType: "dm",
        priorityScore: 88,
        priorityCategory: "important",
      },
    ];

    const inbox = buildInboxFromMessages(cached, {
      limit: 50,
      allowed: allowed as unknown as ReturnType<
        typeof resolveInboxRequest
      >["allowed"],
      groupByThread: true,
      sortByPriority: true,
    });

    expect(inbox.messages.map((message) => message.id)).toEqual([
      "discord:mem-new",
      "discord:mem-old",
    ]);
    expect(inbox.channelCounts.discord).toEqual({ total: 2, unread: 2 });
    expect(inbox.threadGroups?.[0]?.maxPriorityScore).toBe(88);
    expect(inbox.threadGroups?.[0]?.priorityCategory).toBe("important");
  });
});

describe("LifeOps inbox cache modes", () => {
  class BareInboxBase {
    constructor(
      public readonly runtime: Record<string, unknown>,
      public readonly repository: Record<string, unknown>,
    ) {}
  }

  const InboxService = withInbox(
    BareInboxBase as unknown as Parameters<typeof withInbox>[0],
  );

  function cachedMessage(
    id: string,
    receivedAt: string,
  ): LifeOpsCachedInboxMessage {
    return {
      id,
      channel: "telegram",
      sender: {
        id: "user-1",
        displayName: "Alice",
        email: null,
        avatarUrl: null,
      },
      subject: null,
      snippet: "cached",
      receivedAt,
      unread: true,
      deepLink: null,
      sourceRef: { channel: "telegram", externalId: id.replace(/^telegram:/, "") },
      threadId: "room-1",
      chatType: "dm",
      cachedAt: "2026-04-21T12:00:00.000Z",
      updatedAt: "2026-04-21T12:00:00.000Z",
      priorityFlags: [],
    };
  }

  function makeRuntime() {
    const roomId = "00000000-0000-0000-0000-000000000011";
    const worldId = "00000000-0000-0000-0000-000000000012";
    return {
      agentId: "00000000-0000-0000-0000-000000000010",
      character: { name: "Owner" },
      getRoomsForParticipant: vi.fn(async () => [roomId]),
      getRoom: vi.fn(async () => ({
        id: roomId,
        name: "Telegram DM",
        source: "telegram",
        type: "dm",
        worldId,
        metadata: {},
      })),
      getWorld: vi.fn(async () => ({ id: worldId, metadata: {} })),
      getParticipantsForRoom: vi.fn(async () => ["owner", "sender"]),
      getMemoriesByRoomIds: vi.fn(async () =>
        Array.from({ length: 3 }, (_, index) => ({
          id: `00000000-0000-0000-0000-00000000002${index}`,
          roomId,
          entityId: `00000000-0000-0000-0000-00000000003${index}`,
          createdAt: Date.parse(`2026-04-21T12:0${index}:00.000Z`),
          content: {
            source: "telegram",
            text: `live message ${index}`,
          },
          metadata: {
            entityName: `Sender ${index}`,
          },
        })),
      ),
    };
  }

  function makeRepository(cached: LifeOpsCachedInboxMessage[] = []) {
    return {
      listCachedInboxMessages: vi.fn(async () => cached),
      upsertCachedInboxMessages: vi.fn(async () => undefined),
    };
  }

  it("serves cache-only reads without touching connector fetchers", async () => {
    const runtime = makeRuntime();
    const repository = makeRepository([
      cachedMessage("telegram:cached-1", "2026-04-21T12:00:00.000Z"),
    ]);
    const service = new InboxService(runtime, repository);

    const inbox = await service.getInbox({
      channels: ["telegram"],
      cacheMode: "cache-only",
      limit: 50,
    });

    expect(inbox.messages.map((message) => message.id)).toEqual([
      "telegram:cached-1",
    ]);
    expect(runtime.getRoomsForParticipant).not.toHaveBeenCalled();
    expect(repository.upsertCachedInboxMessages).not.toHaveBeenCalled();
  });

  it("refresh mode ignores fresh cache and stores the full warm window", async () => {
    const runtime = makeRuntime();
    const repository = makeRepository([
      cachedMessage("telegram:cached-fresh", new Date().toISOString()),
    ]);
    const service = new InboxService(runtime, repository);

    const inbox = await service.getInbox({
      channels: ["telegram"],
      cacheMode: "refresh",
      cacheLimit: 3,
      limit: 1,
    });

    expect(inbox.messages).toHaveLength(1);
    expect(runtime.getRoomsForParticipant).toHaveBeenCalledTimes(1);
    expect(runtime.getMemoriesByRoomIds).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 9 }),
    );
    expect(repository.upsertCachedInboxMessages).toHaveBeenCalled();
    const firstCacheWrite =
      repository.upsertCachedInboxMessages.mock.calls[0]?.[1] ?? [];
    expect(firstCacheWrite).toHaveLength(3);
  });
});

describe("resolveInboxRequest — Wave 2F filters", () => {
  it("passes through chatTypeFilter when valid", () => {
    const resolved = resolveInboxRequest({
      chatTypeFilter: ["dm", "group"],
    });
    expect(resolved.chatTypeFilter).toEqual(["dm", "group"]);
  });

  it("drops invalid chatTypeFilter entries", () => {
    const resolved = resolveInboxRequest({
      // @ts-expect-error — testing runtime sanitization of bad enum values
      chatTypeFilter: ["dm", "bogus"],
    });
    expect(resolved.chatTypeFilter).toEqual(["dm"]);
  });

  it("returns undefined chatTypeFilter when omitted or empty", () => {
    expect(resolveInboxRequest({}).chatTypeFilter).toBeUndefined();
    expect(
      resolveInboxRequest({ chatTypeFilter: [] }).chatTypeFilter,
    ).toBeUndefined();
  });

  it("normalizes maxParticipants to a positive integer or undefined", () => {
    expect(resolveInboxRequest({ maxParticipants: 15 }).maxParticipants).toBe(
      15,
    );
    expect(resolveInboxRequest({ maxParticipants: 15.7 }).maxParticipants).toBe(
      15,
    );
    expect(
      resolveInboxRequest({ maxParticipants: 0 }).maxParticipants,
    ).toBeUndefined();
    expect(
      resolveInboxRequest({ maxParticipants: -3 }).maxParticipants,
    ).toBeUndefined();
  });

  it("trims and forwards a non-empty gmailAccountId", () => {
    expect(
      resolveInboxRequest({ gmailAccountId: " grant-1 " }).gmailAccountId,
    ).toBe("grant-1");
    expect(
      resolveInboxRequest({ gmailAccountId: "" }).gmailAccountId,
    ).toBeUndefined();
  });

  it("flips groupByThread on only when explicitly true", () => {
    expect(resolveInboxRequest({}).groupByThread).toBe(false);
    expect(resolveInboxRequest({ groupByThread: true }).groupByThread).toBe(
      true,
    );
  });
});

describe("buildInbox — Wave 2F filters and small-group heuristic", () => {
  type AllowedSet = Set<
    ReturnType<typeof resolveInboxRequest>["allowed"] extends Set<infer T>
      ? T
      : never
  >;
  const allChannels = (): AllowedSet =>
    new Set([
      "gmail",
      "discord",
      "telegram",
      "signal",
      "imessage",
      "whatsapp",
      "sms",
      "x_dm",
    ] as const) as unknown as AllowedSet;

  it("filters out group messages above maxParticipants", () => {
    const inbound: InboundMessage[] = [
      {
        id: "mem-dm",
        source: "telegram",
        roomId: "room-dm",
        entityId: "u1",
        senderName: "Alice",
        channelName: "Alice",
        channelType: "dm",
        text: "hi",
        snippet: "hi",
        timestamp: Date.UTC(2025, 0, 1, 9),
        chatType: "dm",
      },
      {
        id: "mem-small",
        source: "telegram",
        roomId: "room-small",
        entityId: "u2",
        senderName: "Bob",
        channelName: "Crew",
        channelType: "group",
        text: "hey",
        snippet: "hey",
        timestamp: Date.UTC(2025, 0, 1, 10),
        chatType: "group",
        participantCount: 6,
      },
      {
        id: "mem-big",
        source: "telegram",
        roomId: "room-big",
        entityId: "u3",
        senderName: "Carol",
        channelName: "Town hall",
        channelType: "group",
        text: "broadcast",
        snippet: "broadcast",
        timestamp: Date.UTC(2025, 0, 1, 11),
        chatType: "group",
        participantCount: 42,
      },
    ];
    const inbox = buildInbox(inbound, {
      limit: 50,
      allowed: allChannels(),
      maxParticipants: 15,
    });
    const ids = inbox.messages.map((m) => m.id);
    expect(ids).toContain("telegram:mem-dm");
    expect(ids).toContain("telegram:mem-small");
    expect(ids).not.toContain("telegram:mem-big");
  });

  it("filters by chatType — Messages mode keeps DM + small group, drops channels", () => {
    const inbound: InboundMessage[] = [
      {
        id: "mem-dm",
        source: "discord",
        roomId: "r1",
        senderName: "Alice",
        channelName: "Alice",
        channelType: "dm",
        text: "hi",
        snippet: "hi",
        timestamp: 1,
        chatType: "dm",
      },
      {
        id: "mem-group",
        source: "discord",
        roomId: "r2",
        senderName: "Bob",
        channelName: "Devs",
        channelType: "group",
        text: "ok",
        snippet: "ok",
        timestamp: 2,
        chatType: "group",
        participantCount: 4,
      },
      {
        id: "mem-channel",
        source: "discord",
        roomId: "r3",
        senderName: "Carol",
        channelName: "#announcements",
        channelType: "group",
        text: "fyi",
        snippet: "fyi",
        timestamp: 3,
        chatType: "channel",
        participantCount: 999,
      },
    ];
    const inbox = buildInbox(inbound, {
      limit: 50,
      allowed: allChannels(),
      chatTypeFilter: ["dm", "group"],
    });
    const ids = inbox.messages.map((m) => m.id);
    expect(ids.sort()).toEqual(["discord:mem-dm", "discord:mem-group"]);
  });

  it("filters Gmail by gmailAccountId", () => {
    const inbound: InboundMessage[] = [
      {
        id: "g1",
        source: "gmail",
        senderName: "boss@personal.com",
        channelName: "Email from boss@personal.com",
        channelType: "dm",
        text: "hi",
        snippet: "hi",
        timestamp: 1,
        gmailMessageId: "g1-ext",
        gmailAccountId: "grant-personal",
        gmailAccountEmail: "me@personal.com",
      },
      {
        id: "g2",
        source: "gmail",
        senderName: "boss@work.com",
        channelName: "Email from boss@work.com",
        channelType: "dm",
        text: "hello",
        snippet: "hello",
        timestamp: 2,
        gmailMessageId: "g2-ext",
        gmailAccountId: "grant-work",
        gmailAccountEmail: "me@work.com",
      },
    ];
    const inbox = buildInbox(inbound, {
      limit: 50,
      allowed: allChannels(),
      gmailAccountId: "grant-work",
    });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]?.gmailAccountId).toBe("grant-work");
    expect(inbox.messages[0]?.gmailAccountEmail).toBe("me@work.com");
  });

  it("scores small-group threads via the v1 heuristic", () => {
    const inbound: InboundMessage[] = [
      {
        id: "mem-1",
        source: "telegram",
        roomId: "room-plan",
        entityId: "u-friend",
        senderName: "Friend",
        channelName: "Trip squad",
        channelType: "group",
        text: "can we meet tomorrow at 3pm Shaw?",
        snippet: "can we meet tomorrow at 3pm Shaw?",
        timestamp: Date.UTC(2025, 0, 5, 9),
        chatType: "group",
        participantCount: 4,
      },
      {
        id: "mem-2",
        source: "telegram",
        roomId: "room-plan",
        entityId: "u-other",
        senderName: "Other",
        channelName: "Trip squad",
        channelType: "group",
        text: "+1",
        snippet: "+1",
        timestamp: Date.UTC(2025, 0, 5, 8),
        chatType: "group",
        participantCount: 4,
      },
    ];
    const inbox = buildInbox(inbound, {
      limit: 50,
      allowed: allChannels(),
      groupByThread: true,
      ownerName: "Shaw",
    });
    expect(inbox.threadGroups).toBeDefined();
    const group = inbox.threadGroups?.[0];
    expect(group?.chatType).toBe("group");
    expect(group?.participantCount).toBe(4);
    // mention (30) + question (20) + date-like (15) + most-recent group (10)
    expect(group?.maxPriorityScore).toBe(75);
    expect(group?.latestMessage.priorityScore).toBe(75);
  });

  it("does not score large groups (>15 participants)", () => {
    const inbound: InboundMessage[] = [
      {
        id: "mem-large",
        source: "telegram",
        roomId: "room-big",
        senderName: "Anyone",
        channelName: "Megagroup",
        channelType: "group",
        text: "tomorrow at 3pm? Shaw",
        snippet: "tomorrow at 3pm? Shaw",
        timestamp: Date.UTC(2025, 0, 1, 9),
        chatType: "group",
        participantCount: 50,
      },
    ];
    const inbox = buildInbox(inbound, {
      limit: 50,
      allowed: allChannels(),
      groupByThread: true,
      ownerName: "Shaw",
    });
    const group = inbox.threadGroups?.[0];
    // No participantCount cap was applied, so the message is in the feed —
    // but the heuristic must skip it because the group is too large.
    expect(group?.maxPriorityScore).toBeUndefined();
  });

  it("populates thread groups with the visible message window (newest first)", () => {
    const inbound: InboundMessage[] = [
      {
        id: "mem-old",
        source: "telegram",
        roomId: "room-1",
        senderName: "Alice",
        channelName: "Alice",
        channelType: "dm",
        text: "first",
        snippet: "first",
        timestamp: Date.UTC(2025, 0, 1, 9),
        chatType: "dm",
      },
      {
        id: "mem-new",
        source: "telegram",
        roomId: "room-1",
        senderName: "Alice",
        channelName: "Alice",
        channelType: "dm",
        text: "later",
        snippet: "later",
        timestamp: Date.UTC(2025, 0, 1, 10),
        chatType: "dm",
      },
    ];
    const inbox = buildInbox(inbound, {
      limit: 50,
      allowed: allChannels(),
      groupByThread: true,
    });
    const group = inbox.threadGroups?.[0];
    expect(group?.messages.map((m) => m.id)).toEqual([
      "telegram:mem-new",
      "telegram:mem-old",
    ]);
    expect(group?.totalCount).toBe(2);
  });

  it("retrieves missed priority thread groups by any unreplied high-priority member", () => {
    const inbound: InboundMessage[] = [
      {
        id: "room-a-low-latest",
        source: "telegram",
        roomId: "room-a",
        senderName: "Alice",
        channelName: "Alice",
        channelType: "dm",
        text: "thanks",
        snippet: "thanks",
        timestamp: Date.UTC(2025, 0, 3, 12),
        chatType: "dm",
        priorityScore: 10,
      },
      {
        id: "room-a-high-older",
        source: "telegram",
        roomId: "room-a",
        senderName: "Alice",
        channelName: "Alice",
        channelType: "dm",
        text: "can you approve the contract?",
        snippet: "can you approve the contract?",
        timestamp: Date.UTC(2025, 0, 2, 12),
        chatType: "dm",
        priorityScore: 80,
      },
      {
        id: "room-b-replied",
        source: "telegram",
        roomId: "room-b",
        senderName: "Bob",
        channelName: "Bob",
        channelType: "dm",
        text: "urgent but already handled",
        snippet: "urgent but already handled",
        timestamp: Date.UTC(2025, 0, 2, 13),
        chatType: "dm",
        priorityScore: 95,
        repliedAt: "2025-01-02T14:00:00.000Z",
      },
      {
        id: "room-c-high",
        source: "discord",
        roomId: "room-c",
        senderName: "Carol",
        channelName: "Carol",
        channelType: "dm",
        text: "please confirm tomorrow",
        snippet: "please confirm tomorrow",
        timestamp: Date.UTC(2025, 0, 2, 11),
        chatType: "dm",
        priorityScore: 70,
      },
    ];

    const inbox = buildInbox(inbound, {
      limit: 50,
      allowed: allChannels(),
      groupByThread: true,
      missedOnly: true,
      sortByPriority: true,
    });

    expect(inbox.messages.map((message) => message.id).sort()).toEqual([
      "discord:room-c-high",
      "telegram:room-a-high-older",
    ]);
    expect(inbox.threadGroups?.map((group) => group.threadId)).toEqual([
      "room-a",
      "room-c",
    ]);
    expect(inbox.threadGroups?.[0]?.maxPriorityScore).toBe(80);
    expect(
      inbox.threadGroups?.some((group) => group.threadId === "room-b"),
    ).toBe(false);
  });
});

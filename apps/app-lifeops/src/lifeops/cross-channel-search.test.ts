import type { IAgentRuntime, Memory, Room, UUID } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsXFeedItem,
  LifeOpsXDm,
} from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/agent", () => ({
  getMemoriesForCluster: vi.fn(),
  resolveRelationshipsGraphService: vi.fn(async () => null),
}));

import { runCrossChannelSearch } from "./cross-channel-search.js";

type RuntimeStub = IAgentRuntime & {
  getService: ReturnType<typeof vi.fn>;
  useModel?: ReturnType<typeof vi.fn>;
  searchMemories?: ReturnType<typeof vi.fn>;
  getRoom?: ReturnType<typeof vi.fn>;
};

function messageMemory(overrides: Partial<Memory>): Memory {
  return {
    id: "mem-1" as UUID,
    roomId: "room-1" as UUID,
    entityId: "user-1" as UUID,
    content: { text: "Frontier Tower memory" },
    createdAt: Date.parse("2026-04-01T10:00:00.000Z"),
    ...overrides,
  } as Memory;
}

function room(source: string, name: string): Room {
  return {
    id: `${source}-room` as UUID,
    name,
    source,
  } as Room;
}

function calendarEvent(
  overrides: Partial<LifeOpsCalendarEvent> = {},
): LifeOpsCalendarEvent {
  return {
    id: "cal-1",
    externalId: "cal-ext-1",
    agentId: "agent",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "Frontier Tower kickoff",
    description: "Planning review",
    location: "Frontier Tower",
    status: "confirmed",
    startAt: "2026-04-02T16:00:00.000Z",
    endAt: "2026-04-02T17:00:00.000Z",
    isAllDay: false,
    timezone: "America/Los_Angeles",
    htmlLink: "https://calendar.test/cal-1",
    conferenceLink: null,
    organizer: { displayName: "Planner", email: "planner@example.com" },
    attendees: [],
    metadata: {},
    syncedAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function xPost(overrides: Partial<LifeOpsXFeedItem> = {}): LifeOpsXFeedItem {
  return {
    id: "x-feed-1",
    agentId: "agent",
    externalTweetId: "123",
    authorHandle: "@alice",
    authorId: "alice-id",
    text: "Frontier Tower update",
    createdAtSource: "2026-04-03T10:00:00.000Z",
    feedType: "search",
    metadata: {},
    syncedAt: "2026-04-03T10:00:00.000Z",
    updatedAt: "2026-04-03T10:00:00.000Z",
    ...overrides,
  };
}

function xDm(overrides: Partial<LifeOpsXDm> = {}): LifeOpsXDm {
  return {
    id: "x-dm-1",
    agentId: "agent",
    externalDmId: "dm-1",
    conversationId: "conv-1",
    senderHandle: "@bob",
    senderId: "bob-id",
    isInbound: true,
    text: "Frontier Tower DM",
    receivedAt: "2026-04-03T12:00:00.000Z",
    readAt: null,
    repliedAt: null,
    metadata: {},
    syncedAt: "2026-04-03T12:00:00.000Z",
    updatedAt: "2026-04-03T12:00:00.000Z",
    ...overrides,
  };
}

function createRuntime(
  args: {
    service?: Record<string, unknown> | null;
    memories?: Memory[];
    rooms?: Record<string, Room>;
    memorySearch?: boolean;
  } = {},
): RuntimeStub {
  const runtime: RuntimeStub = {
    agentId: "agent" as UUID,
    getService: vi.fn((name: string) =>
      name === "lifeops" ? (args.service ?? null) : null,
    ),
  } as RuntimeStub;
  if (args.memorySearch !== false) {
    runtime.useModel = vi.fn(async (type: ModelType) =>
      type === ModelType.TEXT_EMBEDDING ? [0.1, 0.2] : "",
    );
    runtime.searchMemories = vi.fn(async () => args.memories ?? []);
    runtime.getRoom = vi.fn(
      async (id: UUID) => args.rooms?.[String(id)] ?? null,
    );
  }
  return runtime;
}

describe("runCrossChannelSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fans broad searches across native and memory-backed adapters with citations", async () => {
    const service = {
      getGmailSearch: vi.fn(async () => ({
        messages: [
          {
            id: "gm-1",
            from: "lead@example.com",
            subject: "Frontier Tower budget",
            snippet: "Frontier Tower budget notes",
            receivedAt: "2026-04-01T09:00:00.000Z",
            htmlLink: "https://mail.test/gm-1",
          },
        ],
      })),
      searchTelegramMessages: vi.fn(async () => [
        {
          id: "tg-1",
          dialogId: "dialog-1",
          dialogTitle: "Ops",
          username: "alice",
          content: "Frontier Tower telegram note",
          timestamp: "2026-04-01T11:00:00.000Z",
          outgoing: false,
        },
      ]),
      searchDiscordMessages: vi.fn(async () => [
        {
          id: "dc-1",
          content: "Frontier Tower discord note",
          authorName: "Dana",
          channelId: "channel-1",
          timestamp: "2026-04-01T12:00:00.000Z",
        },
      ]),
      searchIMessages: vi.fn(async () => [
        {
          id: "im-1",
          fromHandle: "+15551230000",
          toHandles: ["me"],
          text: "Frontier Tower iMessage",
          isFromMe: false,
          sentAt: "2026-04-01T13:00:00.000Z",
          chatId: "chat-1",
        },
      ]),
      getCalendarFeed: vi.fn(async () => ({
        calendars: [],
        events: [calendarEvent()],
        fetchedAt: "2026-04-01T00:00:00.000Z",
      })),
      searchXPosts: vi.fn(async () => [xPost()]),
      getXDms: vi.fn(async () => [xDm()]),
    };
    const memories = [
      messageMemory({
        id: "sig-1" as UUID,
        roomId: "signal-room" as UUID,
        content: { text: "Frontier Tower signal memory" },
        createdAt: Date.parse("2026-04-01T14:00:00.000Z"),
      }),
    ];
    const runtime = createRuntime({
      service,
      memories,
      rooms: { "signal-room": room("signal", "Signal crew") },
    });

    const result = await runCrossChannelSearch(runtime, {
      query: "Frontier Tower",
      limit: 3,
    });

    expect(result.unsupported).toEqual([]);
    expect(result.channelsWithHits.sort()).toEqual(
      [
        "calendar",
        "discord",
        "gmail",
        "imessage",
        "signal",
        "telegram",
        "x",
        "x-dm",
      ].sort(),
    );
    expect(
      result.hits.every((hit) => hit.citation.platform && hit.citation.label),
    ).toBe(true);
    expect(
      result.hits.find((hit) => hit.channel === "gmail")?.citation.url,
    ).toBe("https://mail.test/gm-1");
    expect(result.hits.find((hit) => hit.channel === "x")?.citation.url).toBe(
      "https://x.com/alice/status/123",
    );
  });

  it("honors explicit channel searches without calling unrelated native adapters", async () => {
    const service = {
      getGmailSearch: vi.fn(async () => ({ messages: [] })),
      searchTelegramMessages: vi.fn(async () => [
        {
          id: "tg-1",
          dialogId: "dialog-1",
          dialogTitle: "Ops",
          username: "alice",
          content: "Project Zephyr telegram note",
          timestamp: "2026-04-01T11:00:00.000Z",
          outgoing: false,
        },
      ]),
    };
    const runtime = createRuntime({
      service,
      memories: [
        messageMemory({
          id: "tg-mem" as UUID,
          roomId: "telegram-room" as UUID,
          content: { text: "Project Zephyr memory" },
        }),
        messageMemory({
          id: "sig-mem" as UUID,
          roomId: "signal-room" as UUID,
          content: { text: "Project Zephyr signal memory" },
        }),
      ],
      rooms: {
        "telegram-room": room("telegram", "Telegram Ops"),
        "signal-room": room("signal", "Signal Ops"),
      },
    });

    const result = await runCrossChannelSearch(runtime, {
      query: "Project Zephyr",
      channels: ["telegram"],
      limit: 5,
    });

    expect(service.searchTelegramMessages).toHaveBeenCalledTimes(1);
    expect(service.getGmailSearch).not.toHaveBeenCalled();
    expect(result.unsupported).toEqual([]);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.channel === "telegram")).toBe(true);
  });

  it("applies multi-channel allowlists and time windows", async () => {
    const service = {
      getGmailSearch: vi.fn(async () => ({
        messages: [
          {
            id: "gm-old",
            from: "old@example.com",
            subject: "Apollo",
            snippet: "Apollo old",
            receivedAt: "2026-03-01T09:00:00.000Z",
            htmlLink: null,
          },
          {
            id: "gm-new",
            from: "new@example.com",
            subject: "Apollo",
            snippet: "Apollo current",
            receivedAt: "2026-04-05T09:00:00.000Z",
            htmlLink: null,
          },
        ],
      })),
      getCalendarFeed: vi.fn(async () => ({
        calendars: [],
        events: [
          calendarEvent({
            id: "cal-old",
            title: "Apollo old",
            startAt: "2026-03-01T09:00:00.000Z",
          }),
          calendarEvent({
            id: "cal-new",
            title: "Apollo review",
            startAt: "2026-04-06T09:00:00.000Z",
          }),
        ],
        fetchedAt: "2026-04-01T00:00:00.000Z",
      })),
      searchTelegramMessages: vi.fn(async () => []),
    };
    const runtime = createRuntime({ service, memories: [] });

    const result = await runCrossChannelSearch(runtime, {
      query: "Apollo",
      channels: ["gmail", "calendar"],
      timeWindow: {
        startIso: "2026-04-01T00:00:00.000Z",
        endIso: "2026-04-30T23:59:59.000Z",
      },
      limit: 10,
    });

    expect(service.searchTelegramMessages).not.toHaveBeenCalled();
    expect(result.hits.map((hit) => hit.sourceRef).sort()).toEqual([
      "cal-new",
      "gm-new",
    ]);
    expect(
      result.hits.every((hit) => ["gmail", "calendar"].includes(hit.channel)),
    ).toBe(true);
  });

  it("does not fabricate hits and only marks channels unsupported when no adapter can run", async () => {
    const runtime = createRuntime({
      service: {},
      memorySearch: false,
    });

    const result = await runCrossChannelSearch(runtime, {
      query: "anything",
      channels: ["whatsapp", "signal"],
      limit: 5,
    });

    expect(result.hits).toEqual([]);
    expect(result.unsupported.map((entry) => entry.channel).sort()).toEqual([
      "signal",
      "whatsapp",
    ]);
    expect(result.unsupported.every((entry) => entry.reason.length > 0)).toBe(
      true,
    );
  });
});

import { describe, expect, mock, test } from "bun:test";

let keywords: string[] = [];

mock.module("../../../db/repositories", () => ({
  discordConnectionsRepository: {
    findById: async (id: string) => ({
      id,
      bot_user_id: "bot-user",
      character_id: null,
      metadata: { responseMode: "keyword", keywords },
    }),
  },
  userCharactersRepository: { findById: async () => null },
}));

// The keyword gate runs before any runtime work; these modules are never
// reached by the cases below.
mock.module("../../eliza/runtime-factory", () => ({ runtimeFactory: {} }));
mock.module("../../eliza/user-context", () => ({ userContextService: {} }));
mock.module("../secrets/encryption", () => ({ getEncryptionService: () => ({}) }));

const { routeDiscordEvent } = await import("./event-router");

function messageEvent(content: string) {
  return {
    connection_id: "00000000-0000-4000-8000-000000000001",
    organization_id: "00000000-0000-4000-8000-000000000002",
    platform_connection_id: "platform-1",
    event_type: "MESSAGE_CREATE" as const,
    event_id: `event-${content}`,
    guild_id: "guild-1",
    channel_id: "channel-1",
    timestamp: "2026-10-12T00:00:00.000Z",
    data: {
      id: "message-1",
      channel_id: "channel-1",
      guild_id: "guild-1",
      author: { id: "user-1", username: "user", bot: false },
      content,
      timestamp: "2026-10-12T00:00:00.000Z",
    },
  };
}

// A message that passes the keyword gate reaches the character lookup; the
// connection has no linked character, so it then stops with processed=false.
async function passesKeywordGate(keyword: string, content: string) {
  keywords = [keyword];
  const result = await routeDiscordEvent(messageEvent(content));
  return result.processed === false;
}

describe("Discord keyword response mode", () => {
  test("matches keywords written in non-Latin scripts", async () => {
    expect(await passesKeywordGate("엘리자", "엘리자 안녕")).toBe(true);
    expect(await passesKeywordGate("엘리자", "엘리자야 오늘 일정 알려줘")).toBe(true);
    expect(await passesKeywordGate("伊莉莎", "伊莉莎，你好")).toBe(true);
    expect(await passesKeywordGate("エリザ", "エリザ、こんにちは")).toBe(true);
  });

  test("matches keywords that start or end with an accented letter", async () => {
    expect(await passesKeywordGate("café", "meet at the café today")).toBe(true);
    expect(await passesKeywordGate("Éclair", "ask éclair about it")).toBe(true);
  });

  test("keeps whole-word matching for ASCII keywords", async () => {
    expect(await passesKeywordGate("eliza", "hey Eliza, are you there?")).toBe(true);
    expect(await passesKeywordGate("or", "the organization meeting")).toBe(false);
    expect(await passesKeywordGate("eliza", "no keyword here")).toBe(false);
    expect(await passesKeywordGate("엘리자", "no keyword here")).toBe(false);
  });
});

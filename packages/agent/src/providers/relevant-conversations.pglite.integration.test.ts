/**
 * Real runtime coverage for the production relevant-conversations provider.
 * The test uses AgentRuntime plus PGlite for rooms, participants, and messages;
 * only the embedding call is deterministic so the provider executes the same
 * recall entrypoint used in production without requiring a live model key.
 */
import fs from "node:fs";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const embedRecallQuery =
  vi.fn<(runtime: IAgentRuntime, text: string) => Promise<number[] | null>>();

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    embedRecallQuery: (runtime: IAgentRuntime, text: string) =>
      embedRecallQuery(runtime, text),
  };
});

const {
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  createMessageMemory,
  stringToUuid,
} = await import("@elizaos/core");
const { createTestRuntime } = await import("@elizaos/core/testing");
const { relevantConversationsProvider } = await import(
  "./relevant-conversations.ts"
);

import type { Memory, State, UUID } from "@elizaos/core";
import type { TestRuntimeResult } from "@elizaos/core/testing";

const OWNER = "11111111-1111-1111-1111-111111111111" as UUID;
const GUEST = "33333333-3333-3333-3333-333333333333" as UUID;
const DISCORD_ROOM = "44444444-4444-4444-4444-444444444444" as UUID;
const TELEGRAM_ROOM = "55555555-5555-5555-5555-555555555555" as UUID;
const GROUP_ROOM = "77777777-7777-7777-7777-777777777777" as UUID;
const APP_ROOM = "99999999-9999-9999-9999-999999999999" as UUID;
const WORLD = "88888888-8888-8888-8888-888888888888" as UUID;
const EMPTY_STATE = { values: {}, data: {}, text: "" } as unknown as State;

function vector(seed: number): number[] {
  const embedding = Array(384).fill(0);
  embedding[0] = seed;
  return embedding;
}

function canonicalMessage(args: {
  id: UUID;
  entityId: UUID;
  roomId: UUID;
  source: "discord" | "telegram";
  accountId: string;
  platformMessageId: string;
  text: string;
  embedding: number[];
}): Memory {
  const memory = createMessageMemory({
    id: args.id,
    entityId: args.entityId,
    roomId: args.roomId,
    content: {
      text: args.text,
      source: args.source,
      channelType: ChannelType.DM,
    },
    embedding: args.embedding,
  });
  memory.metadata = {
    type: "message",
    timestamp: memory.createdAt,
    scope: "private",
    provider: args.source,
    accountId: args.accountId,
    platformMessageId: args.platformMessageId,
    sourceId: args.platformMessageId,
    [args.source]: {
      id: args.entityId,
      userId: args.entityId,
      accountId: args.accountId,
      messageId: args.platformMessageId,
    },
  };
  return memory as Memory;
}

describe("relevantConversationsProvider on AgentRuntime + PGlite", () => {
  let testRuntime: TestRuntimeResult | undefined;

  beforeEach(async () => {
    embedRecallQuery.mockReset();
    embedRecallQuery.mockResolvedValue(vector(1));
    testRuntime = await createTestRuntime({
      characterName: "RelevantProviderCanonicalMemoryAgent",
      removePgliteDirOnCleanup: false,
    });
    testRuntime.runtime.character.settings = {
      ...(testRuntime.runtime.character.settings ?? {}),
      ELIZA_ADMIN_ENTITY_ID: OWNER,
    };
  }, 180_000);

  afterEach(async () => {
    if (testRuntime) {
      const { pgliteDir, cleanup } = testRuntime;
      await cleanup();
      fs.rmSync(pgliteDir, { recursive: true, force: true });
      testRuntime = undefined;
    }
  });

  async function ensureRoom(
    roomId: UUID,
    entityId: UUID,
    type:
      | typeof ChannelType.DM
      | typeof ChannelType.GROUP
      | typeof ChannelType.API,
    source: string,
  ): Promise<void> {
    if (!testRuntime) throw new Error("runtime not initialized");
    await testRuntime.runtime.ensureConnection({
      entityId,
      roomId,
      userName: entityId,
      source,
      type,
      worldId: WORLD,
      worldName: "Relevant provider canonical memory world",
      channelId: `${source}:${roomId}`,
    });
  }

  async function ownerTurn(roomId: UUID, source: "discord" | "telegram") {
    if (!testRuntime) throw new Error("runtime not initialized");
    const message = createMessageMemory({
      entityId: OWNER,
      agentId: testRuntime.runtime.agentId,
      roomId,
      content: {
        text: "what launch code did I mention?",
        source,
      },
    });
    await attestDeliveryAudienceFromCanonicalRoom(testRuntime.runtime, message);
    return message;
  }

  it("recalls canonical private context bidirectionally between owner DMs", async () => {
    if (!testRuntime) throw new Error("runtime not initialized");
    const { runtime } = testRuntime;
    await ensureRoom(DISCORD_ROOM, OWNER, ChannelType.DM, "discord");
    await ensureRoom(TELEGRAM_ROOM, OWNER, ChannelType.DM, "telegram");

    await runtime.createMemory(
      canonicalMessage({
        id: stringToUuid("provider-discord-first") as UUID,
        entityId: OWNER,
        roomId: DISCORD_ROOM,
        source: "discord",
        accountId: "discord-main",
        platformMessageId: "discord-message-1",
        text: "Discord says the launch code is soliza-alpha.",
        embedding: vector(1),
      }),
      "messages",
    );
    await runtime.createMemory(
      canonicalMessage({
        id: stringToUuid("provider-telegram-first") as UUID,
        entityId: OWNER,
        roomId: TELEGRAM_ROOM,
        source: "telegram",
        accountId: "telegram-main",
        platformMessageId: "telegram-message-9",
        text: "Telegram says the launch code is soliza-beta.",
        embedding: vector(0.95),
      }),
      "messages",
    );

    const telegramResult = await relevantConversationsProvider.get(
      runtime,
      await ownerTurn(TELEGRAM_ROOM, "telegram"),
      EMPTY_STATE,
    );
    expect(telegramResult.text).toContain(
      "Discord says the launch code is soliza-alpha.",
    );
    expect(telegramResult.text).not.toContain(
      "Telegram says the launch code is soliza-beta.",
    );

    const discordResult = await relevantConversationsProvider.get(
      runtime,
      await ownerTurn(DISCORD_ROOM, "discord"),
      EMPTY_STATE,
    );
    expect(discordResult.text).toContain(
      "Telegram says the launch code is soliza-beta.",
    );
  });

  it("recalls an unstamped app message after the trusted persistence boundary stamps provenance", async () => {
    if (!testRuntime) throw new Error("runtime not initialized");
    const { runtime } = testRuntime;
    await ensureRoom(APP_ROOM, OWNER, ChannelType.API, "client_chat");
    await ensureRoom(TELEGRAM_ROOM, OWNER, ChannelType.DM, "telegram");
    const unstamped = createMessageMemory({
      id: stringToUuid("provider-app-origin") as UUID,
      entityId: OWNER,
      agentId: runtime.agentId,
      roomId: APP_ROOM,
      content: {
        text: "The app chat says the launch code is soliza-local.",
        source: "client_chat",
        channelType: ChannelType.API,
      },
      embedding: vector(1),
    });
    expect(unstamped.metadata).not.toHaveProperty("accountId");
    expect(unstamped.metadata).not.toHaveProperty("platformMessageId");

    const { persistConversationMemory } = await import("../api/chat-routes.ts");
    const stored = await persistConversationMemory(runtime, unstamped);
    expect(stored.metadata).toMatchObject({
      provider: "client_chat",
      accountId: runtime.agentId,
      platformMessageId: unstamped.id,
    });

    const result = await relevantConversationsProvider.get(
      runtime,
      await ownerTurn(TELEGRAM_ROOM, "telegram"),
      EMPTY_STATE,
    );
    expect(result.text).toContain(
      "The app chat says the launch code is soliza-local.",
    );
    expect(result.values?.relevantConversationAvailability).toBe("complete");
  });

  it("gates private canonical context in a live group-room delivery", async () => {
    if (!testRuntime) throw new Error("runtime not initialized");
    const { runtime } = testRuntime;
    await ensureRoom(DISCORD_ROOM, OWNER, ChannelType.DM, "discord");
    await ensureRoom(GROUP_ROOM, OWNER, ChannelType.GROUP, "discord");
    await ensureRoom(GROUP_ROOM, GUEST, ChannelType.GROUP, "discord");
    await runtime.createMemory(
      canonicalMessage({
        id: stringToUuid("provider-private-discord") as UUID,
        entityId: OWNER,
        roomId: DISCORD_ROOM,
        source: "discord",
        accountId: "discord-main",
        platformMessageId: "private-discord-message",
        text: "Private Discord note: payroll is Friday.",
        embedding: vector(1),
      }),
      "messages",
    );

    const groupTurn = createMessageMemory({
      entityId: OWNER,
      agentId: runtime.agentId,
      roomId: GROUP_ROOM,
      content: {
        text: "what private payroll note did I mention?",
        source: "discord",
      },
    });
    await attestDeliveryAudienceFromCanonicalRoom(runtime, groupTurn);

    const result = await relevantConversationsProvider.get(
      runtime,
      groupTurn,
      EMPTY_STATE,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(embedRecallQuery).not.toHaveBeenCalled();
  });
});

import type { IAgentRuntime } from "@elizaos/core";
import { resolveTelegramRuntimeEntityId } from "@elizaos/plugin-telegram";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelegramStandaloneMessage } from "./handler";
import { resolveStandaloneTelegramEntityId } from "./identity";

function makeRuntime() {
  const cache = new Map<string, unknown>();
  const createMemory = vi.fn(async () => undefined);
  const handleMessage = vi.fn(async () => undefined);
  const runtime = {
    agentId: "agent-1",
    getSetting: vi.fn(() => undefined),
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    ensureConnection: vi.fn(async () => undefined),
    createMemory,
    messageService: { handleMessage },
  } as unknown as IAgentRuntime;
  return { runtime, cache, createMemory, handleMessage };
}

function context(chatId: number, messageId = 7) {
  const chat = { id: chatId, type: "private", first_name: "Ada" };
  const from = { id: 42, first_name: "Ada", username: "ada", is_bot: false };
  return {
    chat,
    from,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      text: `hello from ${chatId}`,
      chat,
      from,
    },
    reply: vi.fn(async () => ({ message_id: 8, date: 1_700_000_001, chat })),
  } as never;
}

describe("standalone Telegram durable identity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scopes inbound memory identity by account, chat, and message id", async () => {
    const { runtime, handleMessage } = makeRuntime();

    await handleTelegramStandaloneMessage(runtime, context(111));
    await handleTelegramStandaloneMessage(runtime, context(222));

    expect(handleMessage).toHaveBeenCalledTimes(2);
    const ids = handleMessage.mock.calls.map((call) => call[1].id);
    expect(new Set(ids).size).toBe(2);
  });

  it("deduplicates a successfully processed redelivery", async () => {
    const { runtime, handleMessage } = makeRuntime();
    const update = context(111);

    await handleTelegramStandaloneMessage(runtime, update);
    await handleTelegramStandaloneMessage(runtime, update);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(runtime.setCache).toHaveBeenCalledWith(
      "telegram-standalone:processed:default:111:7",
      expect.any(Object)
    );
  });

  it("uses the same unmatched user entity id as the plugin connector", async () => {
    const { runtime } = makeRuntime();

    await expect(resolveStandaloneTelegramEntityId(runtime, "default", "555001")).resolves.toBe(
      await resolveTelegramRuntimeEntityId(runtime, "default", "555001")
    );
  });
});

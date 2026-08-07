/**
 * Exercises standalone Telegram identity and redelivery behavior with a
 * deterministic runtime double and no network transport.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTelegramRuntimeEntityId } from "../identity";
import { handleTelegramStandaloneMessage } from "./handler";

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
    reportError: vi.fn(),
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
      expect.any(Object),
    );
  });

  it("scopes unmatched connector identities by account and user", async () => {
    const { runtime } = makeRuntime();

    const [first, otherAccount, otherUser] = await Promise.all([
      resolveTelegramRuntimeEntityId(runtime, "default", "555001"),
      resolveTelegramRuntimeEntityId(runtime, "other", "555001"),
      resolveTelegramRuntimeEntityId(runtime, "default", "555002"),
    ]);

    expect(otherAccount).not.toBe(first);
    expect(otherUser).not.toBe(first);
  });

  it("rejects updates without a stable message id", async () => {
    const { runtime, handleMessage } = makeRuntime();
    const update = context(111) as { message: { message_id?: number } };
    delete update.message.message_id;

    await handleTelegramStandaloneMessage(runtime, update as never);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(runtime.reportError).toHaveBeenCalledWith(
      "telegram-standalone:missing-message-id",
      expect.any(Error),
      { accountId: "default", chatId: "111" },
    );
  });

  it("rejects updates without a stable sender id", async () => {
    const { runtime, handleMessage } = makeRuntime();
    const update = context(111) as {
      from?: unknown;
      message: { from?: unknown };
    };
    delete update.from;
    delete update.message.from;

    await handleTelegramStandaloneMessage(runtime, update as never);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(runtime.reportError).toHaveBeenCalledWith(
      "telegram-standalone:missing-sender-id",
      expect.any(Error),
      { accountId: "default", chatId: "111" },
    );
  });
});

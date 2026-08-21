/**
 * Exercises standalone Telegram identity and redelivery behavior with a
 * deterministic runtime double and no network transport.
 */
import { type IAgentRuntime, logger } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTelegramRuntimeEntityId } from "../identity";
import { handleTelegramStandaloneMessage } from "./handler";

function makeRuntime(
  options: {
    settings?: Record<string, unknown>;
    pairingAllowed?: boolean;
    pairingService?: boolean;
  } = {},
) {
  const cache = new Map<string, unknown>();
  const createMemory = vi.fn(async () => undefined);
  const handleMessage = vi.fn(async () => undefined);
  const pairingService = {
    isAllowed: vi.fn(async () => options.pairingAllowed ?? false),
    upsertRequest: vi.fn(async () => ({ code: "PAIRCODE1", created: true })),
    claimPairingReply: vi.fn(() => true),
  };
  const runtime = {
    agentId: "agent-1",
    // These tests exercise identity and redelivery, not the DM gate, so the
    // policy defaults to the explicit open opt-in unless a case overrides it
    // (a key present with an undefined value simulates an unset setting).
    getSetting: vi.fn((key: string) => {
      if (options.settings && key in options.settings) {
        return options.settings[key];
      }
      return key === "TELEGRAM_DM_POLICY" ? "open" : undefined;
    }),
    getService: vi.fn(() =>
      options.pairingService === false ? null : pairingService,
    ),
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
  return { runtime, cache, createMemory, handleMessage, pairingService };
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

  it("keeps inbound message content out of production logs", async () => {
    const { runtime } = makeRuntime();
    const infoSpy = vi.spyOn(logger, "info");
    const update = context(111, 9);
    (update as { message: { text: string } }).message.text =
      "secret hunter2 passphrase";

    await handleTelegramStandaloneMessage(runtime, update as never);

    // The receipt is still logged at info — just without the content.
    expect(infoSpy).toHaveBeenCalled();
    const logged = infoSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("passphrase");
    infoSpy.mockRestore();
  });
});

describe("standalone Telegram DM policy gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("holds an unconfigured private chat by default and replies with the pairing code", async () => {
    const { runtime, handleMessage } = makeRuntime({
      settings: { TELEGRAM_DM_POLICY: undefined },
    });
    const update = context(111);

    await handleTelegramStandaloneMessage(runtime, update as never);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(update.reply).toHaveBeenCalledTimes(1);
    expect(update.reply.mock.calls[0][0]).toContain("Pairing code: PAIRCODE1");
  });

  it("fails closed when the PairingService is unavailable", async () => {
    const { runtime, handleMessage } = makeRuntime({
      settings: { TELEGRAM_DM_POLICY: undefined },
      pairingService: false,
    });
    const update = context(111);

    await handleTelegramStandaloneMessage(runtime, update as never);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(runtime.reportError).toHaveBeenCalledWith(
      "pairing-integration",
      expect.any(Error),
      expect.objectContaining({ channel: "telegram", senderId: "42" }),
    );
  });

  it("admits a pairing-approved sender", async () => {
    const { runtime, handleMessage } = makeRuntime({
      settings: { TELEGRAM_DM_POLICY: undefined },
      pairingAllowed: true,
    });

    await handleTelegramStandaloneMessage(runtime, context(111) as never);

    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps group access open but stores ambient turns silently by default", async () => {
    const { runtime, createMemory, handleMessage } = makeRuntime({
      settings: { TELEGRAM_DM_POLICY: undefined },
    });
    const update = context(111) as {
      chat: { type: string };
      message: { chat: { type: string } };
    };
    update.chat.type = "supergroup";
    update.message.chat.type = "supergroup";

    await handleTelegramStandaloneMessage(runtime, update as never);

    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("allows deliberate ambient replies in an admitted group", async () => {
    const { runtime, handleMessage } = makeRuntime({
      settings: {
        TELEGRAM_DM_POLICY: undefined,
        TELEGRAM_GROUP_RESPONSE_POLICY: "ambient",
      },
    });
    const update = context(111) as {
      chat: { type: string };
      message: { chat: { type: string } };
    };
    update.chat.type = "supergroup";
    update.message.chat.type = "supergroup";

    await handleTelegramStandaloneMessage(runtime, update as never);

    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("still honors the allowlist before the DM policy", async () => {
    const { runtime, handleMessage, pairingService } = makeRuntime({
      settings: {
        TELEGRAM_DM_POLICY: undefined,
        TELEGRAM_ALLOWED_CHATS: '["111"]',
      },
    });

    await handleTelegramStandaloneMessage(runtime, context(111) as never);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(pairingService.isAllowed).not.toHaveBeenCalled();
  });
});

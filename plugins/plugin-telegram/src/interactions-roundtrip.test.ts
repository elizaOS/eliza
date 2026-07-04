/**
 * Real round-trip tests for the inbound half of the Telegram interaction
 * support: a button tap is decoded and replayed through the runtime as an
 * ordinary user turn, and a sensitive request is delivered as a DM with a
 * tap-through link button. No behavior is stubbed away — the decode, memory
 * construction, and dispatch all run.
 */
import { encodeReplyCallback } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "./messageManager";
import { telegramDmSensitiveRequestAdapter } from "./sensitive-request-adapter";

function createCallbackManager() {
  const handleMessage = vi.fn(async () => undefined);
  const ensureConnection = vi.fn(async () => undefined);
  const runtime = {
    agentId: "agent-1",
    messageService: { handleMessage },
    ensureConnection,
  };
  const bot = { telegram: { sendMessage: vi.fn(), sendChatAction: vi.fn() } };
  return {
    manager: new MessageManager(bot as never, runtime as never),
    handleMessage,
    ensureConnection,
  };
}

function callbackCtx(data: string | undefined) {
  return {
    callbackQuery: {
      id: "cbq-1",
      ...(data === undefined ? {} : { data }),
      message: {
        chat: { id: 100, type: "private" },
        message_id: 7,
        date: 1_700_000_000,
      },
    },
    from: { id: 42, first_name: "U", username: "u", is_bot: false },
    answerCbQuery: vi.fn(async () => true),
  };
}

describe("Telegram handleCallbackQuery — button tap → user turn", () => {
  it("decodes the tap and dispatches the chosen value as a user message", async () => {
    const { manager, handleMessage } = createCallbackManager();
    const data = encodeReplyCallback("yes");
    expect(data).not.toBeNull();
    const ctx = callbackCtx(data ?? undefined);

    await manager.handleCallbackQuery(ctx as never);

    expect(ctx.answerCbQuery).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const memory = handleMessage.mock.calls[0]?.[1] as {
      content: { text: string };
      entityId: string;
    };
    expect(memory.content.text).toBe("yes");
    // the turn is attributed to the clicking user, not the bot
    expect(memory.entityId).not.toBe("agent-1");
  });

  it("acknowledges but ignores a foreign callback payload", async () => {
    const { manager, handleMessage } = createCallbackManager();
    const ctx = callbackCtx("discord:something-else");

    await manager.handleCallbackQuery(ctx as never);

    expect(ctx.answerCbQuery).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
  });
});

describe("Telegram secret/OAuth DM adapter", () => {
  function runtimeWithBot(sendMessage: ReturnType<typeof vi.fn>) {
    return {
      getService: (name: string) =>
        name === "telegram" ? { bot: { telegram: { sendMessage } } } : null,
    };
  }

  it("delivers a secret request as a DM with a tap-through link button", async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const result = await telegramDmSensitiveRequestAdapter.deliver({
      request: {
        id: "req-1",
        kind: "secret",
        expiresAt: "2099-01-01T00:00:00Z",
        delivery: { reason: "OpenAI API key needed" },
        callback: { url: "https://cloud/secure/req-1" },
        requesterEntityId: "42",
      } as never,
      runtime: runtimeWithBot(sendMessage) as never,
    });

    expect(result.delivered).toBe(true);
    expect(result.url).toBe("https://cloud/secure/req-1");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, extra] = sendMessage.mock.calls[0] as [
      number,
      string,
      { reply_markup?: { inline_keyboard: Array<Array<{ url?: string }>> } },
    ];
    expect(chatId).toBe(42);
    expect(text).toContain("OpenAI API key needed");
    expect(extra.reply_markup?.inline_keyboard?.[0]?.[0]?.url).toBe(
      "https://cloud/secure/req-1",
    );
  });

  it("reports failure when no Telegram bot is available", async () => {
    const result = await telegramDmSensitiveRequestAdapter.deliver({
      request: { id: "r", kind: "secret", requesterEntityId: "42" } as never,
      runtime: { getService: () => null } as never,
    });
    expect(result.delivered).toBe(false);
  });
});

/**
 * Keyless Telegram connector loop e2e (#8801, criterion 5).
 *
 * Unlike the generic {@link connector-loop.test.ts} (which drives
 * `runtime.messageService.handleMessage` directly), this exercises the Telegram
 * connector's REAL code path: a synthetic inbound Telegram update goes through
 * `MessageManager.handleMessage` (the same entrypoint the long-poll bot calls),
 * which does the real inbound→Memory mapping + `ensureConnection`, routes the
 * forced-reply turn through the deterministic mock LLM, and delivers the agent's
 * reply via the connector's REAL outbound seam (`ctx.telegram.sendMessage` — the
 * exact call `sendMessageInChunks` makes, with markdown conversion + chunking).
 * No bot token, no api.telegram.org, no network: the outbound seam is captured,
 * and `apiRoot` is the same wire-mock target the Mockoon `telegram` env serves.
 *
 * Includes the shared-outbound-sanitization round-trip (#15888): a stage-1
 * reply that drifts into native tool-call syntax must reach the Telegram wire
 * seam already sanitized by `@elizaos/core` — Telegram carries no sanitizer of
 * its own.
 */
import { ModelType } from "@elizaos/core";
import { MessageManager } from "@elizaos/plugin-telegram";
import type { Context } from "telegraf";
import { Telegraf } from "telegraf";
import { afterEach, describe, expect, it } from "vitest";
import {
  type LlmProxyFixture,
  type MockLlmRuntime,
  withMockLlmRuntime,
} from "../index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: MockLlmRuntime): MockLlmRuntime {
  cleanups.push(harness.cleanup);
  return harness;
}

interface DeliveredTelegramMessage {
  chatId: number | string;
  text: string;
}

/**
 * Drive one inbound group message through the REAL Telegram MessageManager and
 * capture everything the connector pushes through its outbound seam.
 */
async function driveTelegramTurn(options: {
  inboundText: string;
  fixtures?: LlmProxyFixture[];
}): Promise<{ delivered: DeliveredTelegramMessage[]; chatId: number }> {
  // Heuristic (non-strict) proxy: the reply turn makes several model calls;
  // callers pin only the calls they need via fixtures and the proxy answers
  // the rest deterministically without hand fixtures.
  const harness = track(
    await withMockLlmRuntime({
      strict: false,
      ...(options.fixtures ? { fixtures: options.fixtures } : {}),
    }),
  );

  // The bot is only touched for DM replies / media; a group text reply goes
  // out via `ctx.telegram` (captured below), so `apiRoot` is never hit. Point
  // it at the Mockoon telegram base when present so this composes with the
  // wire-mock fleet, else a placeholder that is never called.
  const apiRoot = process.env.ELIZA_MOCK_TELEGRAM_BASE ?? "http://127.0.0.1:0/";
  const bot = new Telegraf("123456:TEST_TOKEN", {
    telegram: { apiRoot },
  });
  const manager = new MessageManager(bot, harness.runtime, "default");

  // The connector's outbound seam. `sendMessageInChunks` calls exactly these
  // two methods; capturing them is the same surface that, in production, would
  // POST to `${apiRoot}/bot<token>/sendMessage`.
  const delivered: DeliveredTelegramMessage[] = [];
  const captureTelegram = {
    sendChatAction: async () => true,
    sendMessage: async (
      chatId: number | string,
      text: string,
    ): Promise<unknown> => {
      delivered.push({ chatId, text });
      return {
        message_id: delivered.length,
        chat: { id: chatId, type: "group" },
        date: 0,
        text,
      };
    },
  };

  const chat = { id: -1001, type: "group", title: "Eliza Test Group" };
  const from = {
    id: 555_001,
    is_bot: false,
    first_name: "Tester",
    username: "tester",
  };
  const ctx = {
    from,
    chat,
    message: {
      message_id: 100,
      date: Math.floor(Date.now() / 1000),
      text: options.inboundText,
      chat,
      from,
    },
    telegram: captureTelegram,
  } as unknown as Context;

  // `forceReply` is the explicit-invocation path (a slash command / mention):
  // it bypasses the default-off TELEGRAM_AUTO_REPLY gate so the agent replies.
  await manager.handleMessage(ctx, { forceReply: true });

  return { delivered, chatId: chat.id };
}

describe("telegram connector loop (keyless)", () => {
  it("drives a synthetic Telegram message through the mock LLM to a delivered reply", async () => {
    const { delivered, chatId } = await driveTelegramTurn({
      inboundText: "Hello agent, please reply.",
    });

    // The loop closed end-to-end through the real connector: a non-empty reply
    // was delivered back to the inbound chat, generated entirely by the
    // deterministic mock LLM with zero external cost.
    expect(
      delivered.length,
      "the connector delivered at least one outbound reply",
    ).toBeGreaterThan(0);
    expect(
      delivered[0]?.text.trim().length,
      "the delivered reply carries text",
    ).toBeGreaterThan(0);
    expect(
      delivered[0]?.chatId,
      "the reply went back to the inbound chat",
    ).toBe(chatId);
  }, 60_000);

  it("delivers a drifted tool-call reply to the Telegram wire seam already sanitized (#15888)", async () => {
    const { delivered, chatId } = await driveTelegramTurn({
      inboundText: "Say hello and describe your plan.",
      fixtures: [
        {
          name: "drifted-stage1",
          match: { modelType: ModelType.RESPONSE_HANDLER },
          // A stage-1 reply that drifted out of the response grammar into
          // native tool syntax mid-sentence — the live leak shape from #15812.
          // Lowercase tool name on purpose: the stage-1 junk-stripper only
          // swallows unclosed markup followed by an UPPERCASE action token, so
          // this drift survives parsing and must be caught at the shared
          // outbound boundary.
          response: {
            contexts: ["simple"],
            intents: [],
            replyText: "The forecast looks clear.<tool_call>get_weather",
            candidateActionNames: [],
          },
        },
      ],
    });

    expect(
      delivered.length,
      "the connector delivered at least one outbound reply",
    ).toBeGreaterThan(0);
    for (const message of delivered) {
      expect(
        message.text,
        "no delivered Telegram text carries native tool syntax",
      ).not.toMatch(/<\/?(?:tool_call|function_call)\b/i);
    }
    // `sendMessageInChunks` escapes for Telegram MarkdownV2 (hence `\.`) —
    // asserted verbatim so the expectation pins the exact wire payload.
    expect(delivered[0]?.text).toBe("The forecast looks clear\\.");
    expect(delivered[0]?.chatId).toBe(chatId);
  }, 60_000);
});

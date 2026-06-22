/**
 * Keyless Telegram connector loop e2e (#8801, gap 5 — per-plugin harness adoption).
 *
 * This is the Telegram plugin's OWN copy of the connector-loop e2e, living in the
 * plugin's test dir and driven by `withMockLlmRuntime()` from
 * `@elizaos/test-harness`. A synthetic inbound Telegram update goes through the
 * REAL `MessageManager.handleMessage` (the same entrypoint the long-poll bot
 * calls), which does the real inbound→Memory mapping + `ensureConnection`,
 * routes the forced-reply turn through the deterministic mock LLM, and delivers
 * the agent's reply via the connector's REAL outbound seam
 * (`ctx.telegram.sendMessage` — the exact call `sendMessageInChunks` makes, with
 * markdown conversion + chunking).
 *
 * The ONLY mocks are the external `telegraf` context objects. No bot token, no
 * api.telegram.org, no network, NO API keys: the outbound seam is captured.
 */

import { type MockLlmRuntime, withMockLlmRuntime } from "@elizaos/test-harness";
import type { Context } from "telegraf";
import { Telegraf } from "telegraf";
import { afterEach, describe, expect, it } from "vitest";
import { MessageManager } from "../src/index.ts";

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

describe("telegram connector loop (keyless harness)", () => {
  it("drives a synthetic Telegram message through the mock LLM to a delivered reply", async () => {
    // Heuristic (non-strict) proxy: the reply turn makes several model calls;
    // let the proxy answer them deterministically without hand fixtures.
    const harness = track(await withMockLlmRuntime({ strict: false }));

    // The bot is only touched for DM replies / media; a group text reply goes
    // out via `ctx.telegram` (captured below), so `apiRoot` is never hit. Point
    // it at the Mockoon telegram base when present so this composes with the
    // wire-mock fleet, else a placeholder that is never called.
    const apiRoot =
      process.env.ELIZA_MOCK_TELEGRAM_BASE ?? "http://127.0.0.1:0/";
    const bot = new Telegraf("123456:TEST_TOKEN", {
      telegram: { apiRoot },
    });
    const manager = new MessageManager(bot, harness.runtime, "default");

    // The connector's outbound seam. `sendMessageInChunks` calls exactly these
    // two methods; capturing them is the same surface that, in production, would
    // POST to `${apiRoot}/bot<token>/sendMessage`.
    const delivered: Array<{ chatId: number | string; text: string }> = [];
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
        text: "Hello agent, please reply.",
        chat,
        from,
      },
      telegram: captureTelegram,
    } as unknown as Context;

    // `forceReply` is the explicit-invocation path (a slash command / mention):
    // it bypasses the default-off TELEGRAM_AUTO_REPLY gate so the agent replies.
    await manager.handleMessage(ctx, { forceReply: true });

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
    ).toBe(chat.id);
  }, 120_000);
});

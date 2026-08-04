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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  attestDeliveryAudienceFromCanonicalRoom,
  authorizeOwnerExclusiveDisclosure,
  createUniqueUuid,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { type MockLlmRuntime, withMockLlmRuntime } from "@elizaos/test-harness";
import type { Context } from "telegraf";
import { Telegraf } from "telegraf";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTelegramRuntimeEntityId } from "../src/identity.ts";
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
  it("fails closed when a configured owner cannot be read from the identity store", async () => {
    const notReadyRuntime = {
      agentId: "992093a1-27d3-0543-846c-0dafe6e68065",
      getSetting: (key: string) =>
        key === "ELIZA_ADMIN_ENTITY_ID"
          ? "11111111-1111-4111-8111-111111111111"
          : undefined,
    };

    await expect(
      resolveTelegramRuntimeEntityId(
        notReadyRuntime as never,
        "default",
        "555001",
      ),
    ).rejects.toMatchObject({ code: "TELEGRAM_IDENTITY_NOT_READY" });
  });

  it("keeps canonical owner identity and completed-delivery dedupe across a PGlite restart", async () => {
    const pgliteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "telegram-durable-"),
    );
    const ownerId = "11111111-1111-4111-8111-111111111111" as UUID;
    const telegramUserId = "555001";
    const chatId = 555001;
    const messageId = 100;
    let first: MockLlmRuntime | undefined;
    let second: MockLlmRuntime | undefined;

    const createContext = (
      delivered: Array<{ chatId: number | string; text: string }>,
    ): Context => {
      const sendMessage = async (
        target: number | string,
        text: string,
      ): Promise<unknown> => {
        delivered.push({ chatId: target, text });
        return {
          message_id: delivered.length,
          chat: { id: target, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text,
        };
      };
      const chat = { id: chatId, type: "private", first_name: "Ada" };
      const from = {
        id: Number(telegramUserId),
        is_bot: false,
        first_name: "Ada",
        username: "ada",
      };
      return {
        from,
        chat,
        message: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          text: "Remember my launch phrase is solar key and reply once.",
          chat,
          from,
        },
        telegram: {
          sendChatAction: async () => true,
          sendMessage,
        },
      } as unknown as Context;
    };

    try {
      first = await withMockLlmRuntime({ strict: false, pgliteDir });
      first.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId);
      await first.runtime.createEntity({
        id: ownerId,
        agentId: first.runtime.agentId,
        names: ["Ada"],
        metadata: {
          telegram: {
            id: telegramUserId,
            userId: telegramUserId,
            accountId: "default",
          },
        },
      });

      const firstDelivered: Array<{ chatId: number | string; text: string }> =
        [];
      const firstBot = new Telegraf("123456:TEST_TOKEN", {
        telegram: { apiRoot: "http://127.0.0.1:0/" },
      });
      Object.assign(firstBot.telegram, createContext(firstDelivered).telegram);
      const firstManager = new MessageManager(
        firstBot,
        first.runtime,
        "default",
      );
      await firstManager.handleMessage(createContext(firstDelivered), {
        forceReply: true,
      });
      expect(firstDelivered).toHaveLength(1);

      const roomId = createUniqueUuid(first.runtime, String(chatId)) as UUID;
      const memories = await first.runtime.getMemories({
        roomId,
        tableName: "messages",
        count: 20,
      });
      const inbound = memories.find((memory) => memory.entityId === ownerId);
      expect(inbound?.content.text).toContain("solar key");
      if (!inbound) throw new Error("canonical Telegram owner memory missing");
      expect(
        new Set(await first.runtime.getParticipantsForRoom(roomId)),
      ).toEqual(new Set([ownerId, first.runtime.agentId]));
      await attestDeliveryAudienceFromCanonicalRoom(first.runtime, inbound);
      expect(
        (await authorizeOwnerExclusiveDisclosure(first.runtime, inbound))
          .allowed,
      ).toBe(true);

      await first.cleanup();
      first = undefined;

      second = await withMockLlmRuntime({ strict: false, pgliteDir });
      second.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId);
      expect((await second.runtime.getEntityById(ownerId))?.id).toBe(ownerId);

      const replayDelivered: Array<{ chatId: number | string; text: string }> =
        [];
      const secondBot = new Telegraf("123456:TEST_TOKEN", {
        telegram: { apiRoot: "http://127.0.0.1:0/" },
      });
      Object.assign(
        secondBot.telegram,
        createContext(replayDelivered).telegram,
      );
      const secondManager = new MessageManager(
        secondBot,
        second.runtime,
        "default",
      );
      await secondManager.handleMessage(createContext(replayDelivered), {
        forceReply: true,
      });
      expect(replayDelivered).toHaveLength(0);

      const persisted = (await second.runtime.getMemories({
        roomId: createUniqueUuid(second.runtime, String(chatId)) as UUID,
        tableName: "messages",
        count: 20,
      })) as Memory[];
      expect(
        persisted.filter((memory) => memory.entityId === ownerId),
      ).toHaveLength(1);
    } finally {
      await second?.cleanup();
      await first?.cleanup();
      fs.rmSync(pgliteDir, { recursive: true, force: true });
    }
  }, 120_000);

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

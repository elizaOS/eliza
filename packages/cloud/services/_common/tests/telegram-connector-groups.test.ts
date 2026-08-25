/** Exercises Telegram's explicit-invocation group response policy. */

import { describe, expect, test } from "bun:test";
import {
  parseTelegramWebhook,
  resolveTelegramGroupActorRole,
} from "../src/telegram-connector";

function update(message: Record<string, unknown>): string {
  return JSON.stringify({
    update_id: 7001,
    message: {
      message_id: 88,
      date: 1_786_283_200,
      from: { id: 42, first_name: "Ada", is_bot: false },
      chat: { id: -100123456789, type: "supergroup" },
      ...message,
    },
  });
}

const policy = { botUsername: "ElizaIsNotABot" };

describe("parseTelegramWebhook group policy", () => {
  test("keeps group support opt-in", () => {
    expect(
      parseTelegramWebhook(update({ text: "@ElizaIsNotABot hi" })),
    ).toBeNull();
  });

  test("accepts an explicit mention of this bot", () => {
    const event = parseTelegramWebhook(
      update({
        text: "@ElizaIsNotABot hi",
        entities: [{ type: "mention", offset: 0, length: 15 }],
      }),
      undefined,
      policy,
    );

    expect(event).toMatchObject({
      chatId: "-100123456789",
      chatType: "supergroup",
      senderId: "42",
      senderName: "Ada",
      groupInvocation: "mention",
    });
  });

  test("rejects an explicit mention of a different bot", () => {
    expect(
      parseTelegramWebhook(
        update({
          text: "@AnotherBot hi",
          entities: [{ type: "mention", offset: 0, length: 11 }],
        }),
        undefined,
        policy,
      ),
    ).toBeNull();
  });

  test("accepts a command addressed to this bot and rejects another target", () => {
    expect(
      parseTelegramWebhook(
        update({
          text: "/help@ElizaIsNotABot",
          entities: [{ type: "bot_command", offset: 0, length: 20 }],
        }),
        undefined,
        policy,
      ),
    ).not.toBeNull();
    expect(
      parseTelegramWebhook(
        update({
          text: "/help@AnotherBot",
          entities: [{ type: "bot_command", offset: 0, length: 16 }],
        }),
        undefined,
        policy,
      ),
    ).toBeNull();
  });

  test.each([
    [
      "ambient before a reply",
      {
        text: "  /eliza_ambient@AnotherBot on\n",
        entities: [{ type: "bot_command", offset: 2, length: 25 }],
        reply_to_message: {
          message_id: 77,
          from: { is_bot: true, username: "ElizaIsNotABot" },
        },
      },
    ],
    [
      "leave before a mention",
      {
        text: "\t/eliza_leave@AnotherBot @ElizaIsNotABot  ",
        entities: [
          { type: "bot_command", offset: 1, length: 23 },
          { type: "mention", offset: 25, length: 15 },
        ],
      },
    ],
    [
      "link before ambient fallback with a misaligned entity",
      {
        text: "  /eliza_link@AnotherBot 23456789  ",
        entities: [{ type: "bot_command", offset: 0, length: 22 }],
      },
    ],
  ])("rejects a foreign %s", (_case, message) => {
    expect(
      parseTelegramWebhook(update(message), undefined, {
        ...policy,
        allowAmbient: true,
      }),
    ).toBeNull();
  });

  test.each([
    ["current-bot ambient", "  /eliza_ambient@ElizaIsNotABot on\n"],
    ["unqualified ambient", "\t/eliza_ambient off  "],
    ["current-bot leave", "\n/eliza_leave@ElizaIsNotABot  "],
    ["unqualified leave", "  /eliza_leave\t"],
    ["current-bot link", "\t/eliza_link@ElizaIsNotABot 23456789  "],
    ["unqualified link", "  /eliza_link 23456789\n"],
  ])("recognizes a trimmed %s command without entities", (_case, text) => {
    expect(
      parseTelegramWebhook(update({ text }), undefined, {
        ...policy,
        allowAmbient: true,
      }),
    ).toMatchObject({ groupInvocation: "command", text });
  });

  test.each([
    ["unqualified", " /eliza_leave "],
    ["suffixed", " /eliza_link@ElizaIsNotABot 23456789 "],
  ])(
    "keeps a trimmed %s command fail-closed without bot identity",
    (_case, text) => {
      expect(
        parseTelegramWebhook(update({ text }), undefined, {
          botUsername: "  ",
          allowAmbient: true,
        }),
      ).toBeNull();
    },
  );

  test("accepts a reply to this bot but not an arbitrary bot", () => {
    expect(
      parseTelegramWebhook(
        update({
          text: "following up",
          reply_to_message: {
            message_id: 77,
            from: { is_bot: true, username: "ElizaIsNotABot" },
          },
        }),
        undefined,
        policy,
      ),
    ).toMatchObject({
      groupInvocation: "reply",
      replyToMessageId: "77",
    });
    expect(
      parseTelegramWebhook(
        update({
          text: "following up",
          reply_to_message: {
            from: { is_bot: true, username: "AnotherBot" },
          },
        }),
        undefined,
        policy,
      ),
    ).toBeNull();
  });

  test("keeps ambient replies off unless explicitly enabled", () => {
    expect(
      parseTelegramWebhook(update({ text: "ambient" }), undefined, policy),
    ).toBeNull();
    expect(
      parseTelegramWebhook(update({ text: "ambient" }), undefined, {
        ...policy,
        allowAmbient: true,
      }),
    ).toMatchObject({ groupInvocation: "ambient" });
    expect(
      parseTelegramWebhook(
        update({
          text: "@ElizaIsNotABot explicit",
          entities: [{ type: "mention", offset: 0, length: 15 }],
        }),
        undefined,
        { ...policy, allowAmbient: true },
      ),
    ).toMatchObject({ groupInvocation: "mention" });
  });

  test("normalizes bot membership removal without requiring message policy", () => {
    const event = parseTelegramWebhook(
      JSON.stringify({
        update_id: 7002,
        my_chat_member: {
          date: 1_786_283_201,
          from: { id: 42, first_name: "Ada" },
          chat: { id: -100123456789, type: "supergroup" },
          new_chat_member: { status: "kicked" },
        },
      }),
    );

    expect(event).toMatchObject({
      messageId: "7002",
      chatId: "-100123456789",
      chatType: "supergroup",
      membershipChange: "removed",
    });
  });

  test("verifies link authority through the current Telegram membership", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toEndWith("/getChatMember");
      await expect(request.json()).resolves.toEqual({
        chat_id: "-100123456789",
        user_id: "42",
      });
      return Response.json({ ok: true, result: { status: "administrator" } });
    }) as typeof fetch;
    try {
      await expect(
        resolveTelegramGroupActorRole(
          { botToken: "test-token" },
          "-100123456789",
          "42",
        ),
      ).resolves.toBe("administrator");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Exercises the Telegram gateway adapter's verification, extraction, group-link
 * targeting, and outbound delivery against the real connector helpers. Fetch is
 * stubbed only at the Bot API edge so assertions record observed adapter
 * behavior rather than mock return values.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { credentialFingerprint } from "../connector-account";
import { logger } from "../logger";
import {
  TELEGRAM_HOSTED_FILE_MAX_BYTES,
  TELEGRAM_VOICE_MAX_BYTES,
  TELEGRAM_VOICE_MAX_DURATION_SECONDS,
  TelegramApiResponseError,
  telegramAdapter,
} from "./telegram";
import type { ChatEvent } from "./types";

const originalFetch = globalThis.fetch;

const telegramEvent: ChatEvent = {
  platform: "telegram",
  messageId: "101",
  chatId: "42",
  senderId: "42",
  text: "hello",
  rawPayload: {},
};

const twilioEvent: ChatEvent = {
  platform: "twilio",
  messageId: "SM1",
  chatId: "+15551234567",
  senderId: "+15551234567",
  text: "hello",
  rawPayload: {},
};

function privateUpdate(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    update_id: 101,
    message: {
      message_id: 7,
      date: 1_786_827_000,
      from: { id: 42, first_name: "Ada", is_bot: false },
      chat: { id: 42, type: "private" },
      text: "hello from Ada",
      ...overrides,
    },
  });
}

function groupUpdate(
  text: string,
  chatType: "group" | "supergroup" = "supergroup",
): string {
  return JSON.stringify({
    update_id: 7001,
    message: {
      message_id: 88,
      date: 1_786_283_200,
      from: { id: 42, first_name: "Ada", is_bot: false },
      chat: { id: -100123456789, type: chatType },
      text,
    },
  });
}

function membershipUpdate(status: string, chatType = "group"): string {
  return JSON.stringify({
    update_id: 55,
    my_chat_member: {
      date: 1_786_283_200,
      from: { id: 9, first_name: "Ada" },
      chat: { id: -1001, type: chatType },
      new_chat_member: { status },
    },
  });
}

function jsonOk(result: unknown): Response {
  return Response.json({ ok: true, result });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("telegramAdapter exports", () => {
  test("re-exports the hosted file and voice product limits", () => {
    expect(TELEGRAM_HOSTED_FILE_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(TELEGRAM_VOICE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(TELEGRAM_VOICE_MAX_DURATION_SECONDS).toBe(15 * 60);
    expect(TELEGRAM_VOICE_MAX_BYTES).toBeLessThan(
      TELEGRAM_HOSTED_FILE_MAX_BYTES,
    );
  });

  test("re-exports TelegramApiResponseError as a constructible Error subclass", () => {
    const error = new TelegramApiResponseError("rate limited", 429, 2);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TelegramApiResponseError");
    expect(error.errorCode).toBe(429);
    expect(error.retryAfterSeconds).toBe(2);
  });

  test("identifies the adapter as telegram", () => {
    expect(telegramAdapter.platform).toBe("telegram");
  });
});

describe("telegramAdapter.getDedupeScope", () => {
  test("scopes by project and the decimal bot id prefix", () => {
    expect(
      telegramAdapter.getDedupeScope?.(
        { botToken: "123456789:rotated-secret" },
        telegramEvent,
        "acme",
      ),
    ).toBe("project:acme:account:bot:123456789");
  });

  test("uses bot:missing when the config has no bot token", () => {
    expect(telegramAdapter.getDedupeScope?.({}, telegramEvent, "acme")).toBe(
      "project:acme:account:bot:missing",
    );
  });

  test("fingerprints a nonstandard token instead of embedding it", () => {
    const botToken = "opaque-test-credential";
    const scope = telegramAdapter.getDedupeScope?.(
      { botToken },
      telegramEvent,
      "acme",
    );
    expect(scope).toBe(
      `project:acme:account:bot:${credentialFingerprint(botToken)}`,
    );
    expect(scope).not.toContain(botToken);
  });
});

describe("telegramAdapter.verifyWebhook", () => {
  test("rejects and warns when no webhook secret is configured", async () => {
    const warnSpy = spyOn(logger, "warn");
    const request = new Request("https://gateway.example/webhook", {
      headers: { "x-telegram-bot-api-secret-token": "anything" },
    });

    await expect(
      telegramAdapter.verifyWebhook(request, "{}", {}),
    ).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "Telegram webhook secret not configured — rejecting request",
    );
  });

  test("accepts a matching secret token without warning", async () => {
    const warnSpy = spyOn(logger, "warn");
    const request = new Request("https://gateway.example/webhook", {
      headers: { "x-telegram-bot-api-secret-token": "gateway-secret" },
    });

    await expect(
      telegramAdapter.verifyWebhook(request, "{}", {
        webhookSecret: "gateway-secret",
      }),
    ).resolves.toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("rejects a mismatched secret token", async () => {
    const request = new Request("https://gateway.example/webhook", {
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
    });

    await expect(
      telegramAdapter.verifyWebhook(request, "{}", {
        webhookSecret: "gateway-secret",
      }),
    ).resolves.toBe(false);
  });

  test("rejects a request that omits the secret header", async () => {
    const request = new Request("https://gateway.example/webhook");

    await expect(
      telegramAdapter.verifyWebhook(request, "{}", {
        webhookSecret: "gateway-secret",
      }),
    ).resolves.toBe(false);
  });
});

describe("telegramAdapter.extractEvent", () => {
  test("returns null for malformed JSON", async () => {
    await expect(telegramAdapter.extractEvent("{not-json")).resolves.toBeNull();
  });

  test("normalizes a private text message without calling Telegram", async () => {
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches += 1;
      return jsonOk({});
    }) as unknown as typeof fetch;

    const event = await telegramAdapter.extractEvent(privateUpdate());

    expect(fetches).toBe(0);
    expect(event).toMatchObject({
      platform: "telegram",
      messageId: "101",
      platformRecordId: "7",
      chatId: "42",
      chatType: "private",
      senderId: "42",
      senderName: "Ada",
      text: "hello from Ada",
      isCommand: false,
      providerSentAtMs: 1_786_827_000_000,
    });
  });

  test("drops a private message sent by another bot", async () => {
    await expect(
      telegramAdapter.extractEvent(
        privateUpdate({ from: { id: 1, first_name: "Other", is_bot: true } }),
      ),
    ).resolves.toBeNull();
  });

  test("drops a channel post that is neither private nor group", async () => {
    await expect(
      telegramAdapter.extractEvent(
        privateUpdate({ chat: { id: -1002, type: "channel" } }),
      ),
    ).resolves.toBeNull();
  });

  test("parses group membership joins without a bot-identity lookup", async () => {
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches += 1;
      return jsonOk({});
    }) as unknown as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      membershipUpdate("member"),
    );

    expect(fetches).toBe(0);
    expect(event).toMatchObject({
      platform: "telegram",
      messageId: "55",
      chatId: "-1001",
      chatType: "group",
      senderId: "9",
      text: "",
      membershipChange: "joined",
      providerSentAtMs: 1_786_283_200_000,
    });
  });

  test("parses a kicked membership as removed", async () => {
    const event = await telegramAdapter.extractEvent(
      membershipUpdate("kicked", "supergroup"),
    );
    expect(event).toMatchObject({
      chatType: "supergroup",
      membershipChange: "removed",
    });
  });

  test("drops a membership status the connector does not accept", async () => {
    await expect(
      telegramAdapter.extractEvent(membershipUpdate("restricted")),
    ).resolves.toBeNull();
  });

  test("classifies ambient group text when bot identity is already configured", async () => {
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches += 1;
      return jsonOk({});
    }) as unknown as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      groupUpdate("hello group"),
      {
        botUsername: "ElizaBot",
      },
    );

    expect(fetches).toBe(0);
    expect(event).toMatchObject({
      text: "hello group",
      groupInvocation: "ambient",
    });
    expect(event?.groupActorRole).toBeUndefined();
  });

  test("resolves bot identity through getMe for a group ambient message", async () => {
    const botToken = "9001:getme-ambient";
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`https://api.telegram.org/bot${botToken}/getMe`);
      return jsonOk({ username: "ElizaBot" });
    }) as unknown as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      groupUpdate("hello group", "group"),
      { botToken },
    );

    expect(event).toMatchObject({
      chatType: "group",
      text: "hello group",
      groupInvocation: "ambient",
    });
  });

  test("keeps group mentions silent when bot identity lookup fails", async () => {
    const warnSpy = spyOn(logger, "warn");
    const botToken = "9002:getme-fails";
    globalThis.fetch = mock(async () => {
      throw new Error("Telegram unavailable");
    }) as unknown as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      groupUpdate("hello group"),
      {
        botToken,
      },
    );

    expect(event).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "Telegram bot identity lookup failed; group mentions will remain silent",
      { error: "TelegramApiTransportError" },
    );
  });

  test("looks up group authority for an unsuffixed /eliza_link command", async () => {
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toEndWith("/getChatMember");
      expect(await request.json()).toEqual({
        chat_id: "-100123456789",
        user_id: "42",
      });
      return jsonOk({ status: "creator" });
    }) as unknown as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      groupUpdate("/eliza_link 23456789"),
      { botToken: "9003:link", botUsername: "ElizaBot" },
    );

    expect(event).toMatchObject({
      text: "/eliza_link 23456789",
      isCommand: true,
      groupActorRole: "creator",
    });
  });

  test("treats a case-insensitive @bot suffix as this bot", async () => {
    globalThis.fetch = mock(async () =>
      jsonOk({ status: "administrator" }),
    ) as unknown as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      groupUpdate("/eliza_link@elizabot 23456789"),
      { botToken: "9004:link", botUsername: "@ElizaBot" },
    );

    expect(event).toMatchObject({
      groupActorRole: "administrator",
    });
  });

  test("drops a link command addressed to another bot", async () => {
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches += 1;
      return jsonOk({ status: "creator" });
    }) as unknown as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      groupUpdate("/eliza_link@OtherBot 23456789"),
      { botToken: "9005:link", botUsername: "ElizaBot" },
    );

    expect(event).toBeNull();
    expect(fetches).toBe(0);
  });

  test("does not treat a Crockford-invalid code as a link command", async () => {
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches += 1;
      return jsonOk({});
    }) as unknown as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      groupUpdate("/eliza_link 01ABCDEF"),
      { botUsername: "ElizaBot" },
    );

    expect(fetches).toBe(0);
    // "01ABCDEF" contains 0 and 1, which Crockford base32 excludes
    // (TELEGRAM_GROUP_LINK_COMMAND uses [2-9A-HJ-NP-Z]{8}), so this is not a
    // link command and falls through to an ambient group turn.
    expect(event).toMatchObject({
      text: "/eliza_link 01ABCDEF",
      groupInvocation: "ambient",
      isCommand: true,
    });
    expect(event?.groupActorRole).toBeUndefined();
  });

  test("does not treat a short or long code as a link command", async () => {
    const shortEvent = await telegramAdapter.extractEvent(
      groupUpdate("/eliza_link 2345678"),
      { botUsername: "ElizaBot" },
    );
    const longEvent = await telegramAdapter.extractEvent(
      groupUpdate("/eliza_link 234567890"),
      { botUsername: "ElizaBot" },
    );

    expect(shortEvent?.groupActorRole).toBeUndefined();
    expect(longEvent?.groupActorRole).toBeUndefined();
    expect(shortEvent?.text).toBe("/eliza_link 2345678");
    expect(longEvent?.text).toBe("/eliza_link 234567890");
  });

  test("records unknown authority when membership lookup throws", async () => {
    const warnSpy = spyOn(logger, "warn");
    globalThis.fetch = mock(async () => {
      throw new TypeError("socket hang up");
    }) as unknown as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      groupUpdate("Eliza link 23456789"),
      { botToken: "9006:link", botUsername: "ElizaBot" },
    );

    expect(event).toMatchObject({
      text: "Eliza link 23456789",
      groupActorRole: "unknown",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "Telegram group authority lookup failed; link remains fail-closed",
      { error: "TelegramApiTransportError" },
    );
  });

  test("records unknown authority when the bot token is missing for a link", async () => {
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches += 1;
      return jsonOk({ status: "creator" });
    }) as unknown as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      groupUpdate("/eliza_link 23456789"),
      { botUsername: "ElizaBot" },
    );

    expect(fetches).toBe(0);
    expect(event).toMatchObject({ groupActorRole: "unknown" });
  });
});

describe("telegramAdapter outbound delivery", () => {
  test("sendReply rejects a non-Telegram event before calling the API", async () => {
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches += 1;
      return jsonOk({ message_id: 1 });
    }) as unknown as typeof fetch;

    await expect(
      telegramAdapter.sendReply({ botToken: "t" }, twilioEvent, "hi"),
    ).rejects.toThrow(TypeError);
    expect(fetches).toBe(0);
  });

  test("sendTypingIndicator rejects a non-Telegram event before calling the API", async () => {
    await expect(
      telegramAdapter.sendTypingIndicator({ botToken: "t" }, twilioEvent),
    ).rejects.toThrow("Telegram adapter received a non-Telegram event");
  });

  test("resolveVoiceNote rejects a non-Telegram event", async () => {
    await expect(
      telegramAdapter.resolveVoiceNote?.({ botToken: "t" }, twilioEvent),
    ).rejects.toThrow("Telegram adapter received a non-Telegram event");
  });

  test("resolveVoiceNote requires a voice note on the Telegram event", async () => {
    await expect(
      telegramAdapter.resolveVoiceNote?.({ botToken: "t" }, telegramEvent),
    ).rejects.toThrow("Telegram event has no voice note");
  });

  test("sendReply requires a bot token", async () => {
    await expect(
      telegramAdapter.sendReply({}, telegramEvent, "hi"),
    ).rejects.toThrow("Missing botToken for Telegram reply");
  });

  test("sendTypingIndicator requires a bot token", async () => {
    await expect(
      telegramAdapter.sendTypingIndicator({}, telegramEvent),
    ).rejects.toThrow("Missing botToken for Telegram typing");
  });

  test("returns an empty receipt and makes no API call for empty text", async () => {
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches += 1;
      return jsonOk({ message_id: 1 });
    }) as unknown as typeof fetch;

    const receipt = await telegramAdapter.sendReplyWithReceipt?.(
      { botToken: "9007:reply" },
      telegramEvent,
      "",
    );

    expect(fetches).toBe(0);
    expect(receipt).toEqual({ providerMessageIds: [] });
  });

  test("sendReplyWithReceipt records the provider message id", async () => {
    const botToken = "9008:reply";
    let body: unknown;
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
      );
      body = await request.json();
      return jsonOk({ message_id: 77 });
    }) as unknown as typeof fetch;

    const receipt = await telegramAdapter.sendReplyWithReceipt?.(
      { botToken },
      telegramEvent,
      "hello from Eliza",
    );

    expect(body).toEqual({
      chat_id: "42",
      text: "hello from Eliza",
      parse_mode: "Markdown",
    });
    expect(receipt).toEqual({ providerMessageIds: ["77"] });
  });

  test("retries without Markdown after a formatting rejection", async () => {
    const warnSpy = spyOn(logger, "warn");
    const bodies: unknown[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const request = new Request("https://unused", init);
      bodies.push(await request.json());
      if (bodies.length === 1) {
        return Response.json({
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse entities",
        });
      }
      return jsonOk({ message_id: 78 });
    }) as unknown as typeof fetch;

    const receipt = await telegramAdapter.sendReplyWithReceipt?.(
      { botToken: "9009:md" },
      telegramEvent,
      "*hello",
    );

    expect(bodies).toEqual([
      { chat_id: "42", text: "*hello", parse_mode: "Markdown" },
      { chat_id: "42", text: "*hello" },
    ]);
    expect(receipt).toEqual({ providerMessageIds: ["78"] });
    expect(warnSpy).toHaveBeenCalledWith(
      "Telegram sendMessage failed, retrying without Markdown",
      { error: "Bad Request: can't parse entities" },
    );
  });

  test("splits an over-length reply into ordered chunks", async () => {
    const ids: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const request = new Request("https://unused", init);
      const body = (await request.json()) as { text: string };
      ids.push(String(body.text.length));
      return jsonOk({ message_id: ids.length + 100 });
    }) as unknown as typeof fetch;

    const overflow = "a".repeat(4096 + 1);
    const receipt = await telegramAdapter.sendReplyWithReceipt?.(
      { botToken: "9010:chunk" },
      telegramEvent,
      overflow,
    );

    expect(ids).toEqual(["4096", "1"]);
    expect(receipt).toEqual({ providerMessageIds: ["101", "102"] });
  });

  test("propagates TelegramApiResponseError from a non-formatting rejection", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        ok: false,
        error_code: 403,
        description: "Forbidden: bot was blocked by the user",
      }),
    ) as unknown as typeof fetch;

    const error = await telegramAdapter
      .sendReply({ botToken: "9011:blocked" }, telegramEvent, "hi")
      .catch((failure) => failure);

    expect(error).toBeInstanceOf(TelegramApiResponseError);
    expect((error as TelegramApiResponseError).errorCode).toBe(403);
    expect((error as Error).message).toBe(
      "Forbidden: bot was blocked by the user",
    );
  });

  test("sendTypingIndicator posts sendChatAction", async () => {
    const botToken = "9012:typing";
    let body: unknown;
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(
        `https://api.telegram.org/bot${botToken}/sendChatAction`,
      );
      body = await request.json();
      return jsonOk(true);
    }) as unknown as typeof fetch;

    await telegramAdapter.sendTypingIndicator({ botToken }, telegramEvent);
    expect(body).toEqual({ chat_id: "42", action: "typing" });
  });
});

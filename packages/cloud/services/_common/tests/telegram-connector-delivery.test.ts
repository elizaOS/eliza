/** Exercises Telegram provider outcomes at the per-chunk delivery boundary. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  sendTelegramReply,
  TelegramApiResponseError,
  TelegramApiTransportError,
  type TelegramConnectorEvent,
  type TelegramReplyDeliveryHooks,
} from "../src/telegram-connector";

const originalFetch = globalThis.fetch;
const event: TelegramConnectorEvent = {
  platform: "telegram",
  messageId: "123",
  platformRecordId: "456",
  chatId: "789",
  chatType: "private",
  senderId: "789",
  text: "hello",
  isCommand: false,
  rawPayload: {},
};

function hooks(events: string[]): TelegramReplyDeliveryHooks {
  return {
    async prepare(chunks) {
      events.push(`prepare:${chunks.length}`);
    },
    async shouldSend(index) {
      events.push(`claim:${index}`);
      return true;
    },
    async accepted(index, _chunk, providerMessageId) {
      events.push(`accepted:${index}:${providerMessageId}`);
    },
    async rejected(index) {
      events.push(`rejected:${index}`);
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("sendTelegramReply delivery state", () => {
  test("retries only a rate-limited second chunk", async () => {
    const sentTexts: string[] = [];
    let call = 0;
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      sentTexts.push(body.text);
      call += 1;
      if (call === 2) {
        return Response.json({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 1 },
        });
      }
      return Response.json({ ok: true, result: { message_id: call } });
    }) as unknown as typeof fetch;
    const events: string[] = [];

    const receipt = await sendTelegramReply(
      { botToken: "test-token" },
      event,
      `${"a".repeat(4096)}\nb`,
      undefined,
      hooks(events),
    );

    expect(sentTexts).toEqual(["a".repeat(4096), "b", "b"]);
    expect(receipt.providerMessageIds).toEqual(["1", "3"]);
    expect(events).toEqual([
      "prepare:2",
      "claim:0",
      "accepted:0:1",
      "claim:1",
      "rejected:1",
      "claim:1",
      "accepted:1:3",
    ]);
  });

  test("releases an explicit 403 instead of classifying it as ambiguous", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        ok: false,
        error_code: 403,
        description: "Forbidden: bot was blocked by the user",
      }),
    ) as unknown as typeof fetch;
    const events: string[] = [];

    await expect(
      sendTelegramReply(
        { botToken: "test-token" },
        event,
        "reply",
        undefined,
        hooks(events),
      ),
    ).rejects.toBeInstanceOf(TelegramApiResponseError);
    expect(events).toEqual(["prepare:1", "claim:0", "rejected:0"]);
  });

  test("returns persisted provider ids when an accepted chunk is replayed", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("an already-delivered chunk must not be resent");
    }) as unknown as typeof fetch;
    const events: string[] = [];
    const replayHooks = hooks(events);
    replayHooks.shouldSend = async (index) => {
      events.push(`claim:${index}`);
      return false;
    };
    replayHooks.deliveredProviderMessageId = async () => "provider-prior";

    const receipt = await sendTelegramReply(
      { botToken: "test-token" },
      event,
      "reply",
      undefined,
      replayHooks,
    );

    expect(receipt.providerMessageIds).toEqual(["provider-prior"]);
    expect(events).toEqual(["prepare:1", "claim:0"]);
  });

  test("keeps transport failure uncertain", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("socket reset after write");
    }) as unknown as typeof fetch;
    const events: string[] = [];

    await expect(
      sendTelegramReply(
        { botToken: "test-token" },
        event,
        "reply",
        undefined,
        hooks(events),
      ),
    ).rejects.toBeInstanceOf(TelegramApiTransportError);
    expect(events).toEqual(["prepare:1", "claim:0"]);
  });
});

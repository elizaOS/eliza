/** Verifies Telegram provider responses are classified at the real fetch boundary. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  prepareTelegramReply,
  sendTelegramReplyChunk,
  type TelegramConnectorEvent,
} from "../src/telegram-connector";

const originalFetch = globalThis.fetch;
const event: TelegramConnectorEvent = {
  platform: "telegram",
  messageId: "1",
  platformRecordId: "2",
  chatId: "3",
  chatType: "private",
  senderId: "4",
  text: "hello",
  isCommand: false,
  rawPayload: {},
};

describe("Telegram reply delivery classification", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("returns accepted only after a valid provider receipt", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        ok: true,
        result: { message_id: 42, chat: { id: 3, type: "private" } },
      }),
    ) as typeof fetch;
    expect(
      await sendTelegramReplyChunk({ botToken: "secret" }, event, "hello"),
    ).toEqual({ acceptance: "accepted", providerMessageId: "42" });
  });

  test("distinguishes explicit rejection from unknown transport acceptance", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          ok: false,
          error_code: 429,
          description: "rate limited",
          parameters: { retry_after: 8 },
        },
        { status: 429 },
      ),
    ) as typeof fetch;
    expect(
      await sendTelegramReplyChunk({ botToken: "secret" }, event, "hello"),
    ).toEqual({
      acceptance: "not_accepted",
      errorCode: 429,
      retryAfterSeconds: 8,
    });
    globalThis.fetch = mock(async () => {
      throw new Error("connection reset");
    }) as typeof fetch;
    expect(
      await sendTelegramReplyChunk({ botToken: "secret" }, event, "hello"),
    ).toEqual({ acceptance: "unknown" });
    globalThis.fetch = mock(async () =>
      Response.json({ ok: true, result: null }),
    ) as typeof fetch;
    expect(
      await sendTelegramReplyChunk({ botToken: "secret" }, event, "hello"),
    ).toEqual({ acceptance: "unknown" });
  });

  test("creates a deterministic multipart plan without persisting reply text", async () => {
    const text = `${"x".repeat(4096)}\nsecond`;
    const first = await prepareTelegramReply(text);
    const second = await prepareTelegramReply(text);
    expect(first.chunks).toHaveLength(2);
    expect(first.contentDigest).toBe(second.contentDigest);
    expect(first.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

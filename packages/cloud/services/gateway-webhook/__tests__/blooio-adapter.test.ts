/** Focused Blooio send timing, privacy, and original-failure contracts. */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { blooioAdapter } from "../src/adapters/blooio";
import type { ChatEvent, WebhookConfig } from "../src/adapters/types";
import { logger } from "../src/logger";
import { turnRequestFor } from "../src/network-service";

function makeConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    apiKey: "bl_live_test",
    fromNumber: "+15550001111",
    ...overrides,
  } as WebhookConfig;
}

const originalFetch = globalThis.fetch;
const timingSpies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const spy of timingSpies.splice(0)) spy.mockRestore();
});

test("Network turns use the receiving phone while Blooio replies retain their opaque channel", async () => {
  const phone = "+14155550199";
  const line = "+14155550022";
  const channelId = "ch_019fe466-5401-7ac7-a688-100c0f6a21f2";
  const now = Date.now();
  const envelopes = [
    {
      id: "evt_network_recipient_v4",
      type: "message.received",
      created_at: now,
      data: {
        message_id: "msg_network_recipient_v4",
        sender: phone,
        recipient: line,
        channel_id: channelId,
        text: "Show my Friends profile",
        protocol: "imessage",
      },
    },
    {
      event: "message.received",
      message_id: "msg_network_recipient_v2",
      external_id: phone,
      internal_id: line,
      channel_id: channelId,
      text: "Show my Friends profile",
      protocol: "imessage",
      timestamp: now,
    },
  ];
  for (const envelope of envelopes) {
    const event = await blooioAdapter.extractEvent(JSON.stringify(envelope));
    expect(event).not.toBeNull();
    expect(event?.channelId).toBe(channelId);
    expect(event?.receivingNumber).toBe(line);
    const turn = turnRequestFor({ ...event!, gatewayReceivedAtMs: now });
    expect(turn.from).toBe(phone);
    expect(turn.to).toBe(line);
    expect(turn.transport).toBe("imessage");
  }
  const legacyEvent: ChatEvent = {
    platform: "blooio",
    messageId: "legacy",
    chatId: phone,
    senderId: phone,
    channelId: line,
    text: "hello",
    gatewayReceivedAtMs: now,
    rawPayload: {},
  };
  expect(turnRequestFor(legacyEvent).to).toBe(line);
  expect(
    turnRequestFor({ ...legacyEvent, channelId: undefined }).to,
  ).toBeNull();
});

describe("blooio send timing", () => {
  const chatEvent: ChatEvent = {
    platform: "blooio",
    messageId: "msg_abc123",
    chatId: "+15551234567",
    senderId: "+15551234567",
    text: "hey eliza",
    rawPayload: {},
  };

  test("separates provider headers, bounded body and receipt work without logging private data", async () => {
    let clock = 100;
    timingSpies.push(spyOn(performance, "now").mockImplementation(() => clock));
    const output = spyOn(console, "log").mockImplementation(() => {});
    timingSpies.push(output);
    const originalText = Response.prototype.text;
    timingSpies.push(
      spyOn(Response.prototype, "text").mockImplementation(async function (
        this: Response,
      ) {
        const value = await originalText.call(this);
        clock = 149;
        return value;
      }),
    );
    globalThis.fetch = (async () => {
      clock = 111;
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              clock = 137;
              controller.enqueue(
                new TextEncoder().encode('{"id":"private-response-id"}'),
              );
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    }) as typeof fetch;
    const traceId = "1111111111114111a111111111111111";
    await expect(
      blooioAdapter.sendReplyWithReceipt?.(
        makeConfig({ apiKey: "private-key" }),
        { ...chatEvent, traceId },
        "private-message-text",
      ),
    ).resolves.toEqual({ providerMessageIds: ["private-response-id"] });
    expect(output).toHaveBeenCalledTimes(1);
    const encoded = String(output.mock.calls[0][0]);
    expect(JSON.parse(encoded)).toMatchObject({
      message: "Blooio send timing",
      messageId: chatEvent.messageId,
      traceId,
      headersMs: 11,
      bodyMs: 26,
      receiptMs: 12,
      outcome: "accepted",
    });
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(
      300,
    );
    for (const privateValue of [
      "private-key",
      "private-message-text",
      "private-response-id",
      chatEvent.senderId,
    ]) {
      expect(encoded).not.toContain(privateValue);
    }
  });

  test("retains the selected body failure and logs only the attempted phase", async () => {
    let clock = 100;
    timingSpies.push(spyOn(performance, "now").mockImplementation(() => clock));
    const output = spyOn(console, "log").mockImplementation(() => {});
    timingSpies.push(output);
    const failure = new DOMException("private-failure-detail", "TimeoutError");
    globalThis.fetch = (async () => {
      clock = 111;
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              clock = 137;
              controller.error(failure);
            },
          },
          { highWaterMark: 0 },
        ),
      );
    }) as typeof fetch;
    await expect(
      blooioAdapter.sendReply(makeConfig(), chatEvent, "private-text"),
    ).rejects.toBe(failure);
    expect(output).toHaveBeenCalledTimes(1);
    const encoded = String(output.mock.calls[0][0]);
    expect(JSON.parse(encoded)).toMatchObject({
      headersMs: 11,
      bodyMs: 26,
      receiptMs: null,
      outcome: "body_failed",
    });
    expect(encoded).not.toContain("private-failure-detail");
  });

  test("timing logger failure cannot replace the provider failure", async () => {
    const failure = new Error("provider failed");
    timingSpies.push(
      spyOn(logger, "info").mockImplementation(() => {
        throw new Error("logger failed");
      }),
    );
    globalThis.fetch = (async () => {
      throw failure;
    }) as typeof fetch;
    await expect(
      blooioAdapter.sendReply(makeConfig(), chatEvent, "hello"),
    ).rejects.toBe(failure);
  });
});

describe("current-message acknowledgement reactions", () => {
  const sendAcknowledgementReaction = blooioAdapter.sendAcknowledgementReaction;
  if (!sendAcknowledgementReaction)
    throw new Error("Missing acknowledgement adapter");
  const current: ChatEvent = {
    platform: "blooio",
    messageId: "msg_current",
    chatId: "chat_private",
    senderId: "+15555550123",
    text: "Thanks",
    chatType: "private",
    protocol: "imessage",
    rawPayload: {},
  };
  for (const reaction of [
    "love",
    "like",
    "dislike",
    "laugh",
    "emphasize",
    "question",
    "🇯🇵",
    "👍🏽",
    "👩🏽‍💻",
    "1️⃣",
  ]) {
    test(`posts and confirms the exact current target and ${reaction}`, async () => {
      const requests: Array<{ url: string; init: RequestInit }> = [];
      const accepted = spyOn(logger, "info").mockImplementation(() => {});
      timingSpies.push(accepted);
      globalThis.fetch = (async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return Response.json({
          data: { message_id: current.messageId, reaction: `+${reaction}` },
        });
      }) as typeof fetch;
      await sendAcknowledgementReaction(makeConfig(), current, reaction);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(
        `https://api.blooio.com/v4/chats/${current.chatId}/messages/${current.messageId}/reactions`,
      );
      expect(new Headers(requests[0].init.headers).get("Idempotency-Key")).toBe(
        `gw-ack-${current.messageId}`,
      );
      expect(JSON.parse(String(requests[0].init.body))).toEqual({
        reaction: `+${reaction}`,
      });
      expect(
        accepted.mock.calls.some(
          ([message]) => message === "Blooio acknowledgement accepted",
        ),
      ).toBe(true);
    });
  }

  test("rejects unverified targets and invalid choices without a provider call", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("must not send");
    }) as typeof fetch;
    for (const change of [
      { chatId: "+15555550123" },
      { chatType: "group" },
      { protocol: "sms" },
      { messageId: "" },
      { messageId: "msg_current\n" },
      { membershipChange: "joined" as const },
      { platform: "twilio" as const },
    ])
      await sendAcknowledgementReaction(
        makeConfig(),
        { ...current, ...change },
        "like",
      );
    for (const reaction of [
      "+like",
      "-love",
      "+😂",
      "-😂",
      "😀😀",
      "great 👍",
      "😀\n",
    ])
      await sendAcknowledgementReaction(makeConfig(), current, reaction);
    await sendAcknowledgementReaction(
      makeConfig({ apiKey: undefined }),
      current,
      "like",
    );
    expect(calls).toBe(0);
  });

  test("wrong receipts and transport uncertainty are never reported accepted or retried", async () => {
    const accepted = spyOn(logger, "info").mockImplementation(() => {});
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    timingSpies.push(accepted, warning);
    for (const reply of [
      { data: { message_id: "another-message", reaction: "+like" } },
      { data: { message_id: current.messageId, reaction: "+love" } },
      { data: { message_id: current.messageId } },
      {},
    ]) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return Response.json(reply);
      }) as typeof fetch;
      await expect(
        sendAcknowledgementReaction(makeConfig(), current, "like"),
      ).resolves.toBeUndefined();
      expect(calls).toBe(1);
    }
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("private-key-and-message-body");
    }) as typeof fetch;
    await expect(
      sendAcknowledgementReaction(makeConfig(), current, "like"),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(
      accepted.mock.calls.some(
        ([message]) => message === "Blooio acknowledgement accepted",
      ),
    ).toBe(false);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      "private-key-and-message-body",
    );
  });

  test("read feedback is independent of a reply and deferred typing does not read twice", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return Response.json({});
    }) as typeof fetch;
    const sendReadReceipt = blooioAdapter.sendReadReceipt;
    if (!sendReadReceipt) throw new Error("Missing read receipt adapter");
    await sendReadReceipt(makeConfig(), current);
    await blooioAdapter.sendTypingIndicator(makeConfig(), current, {
      markRead: false,
    });
    expect(urls).toEqual([
      `https://api.blooio.com/v4/chats/${current.chatId}/read`,
      `https://api.blooio.com/v4/chats/${current.chatId}/typing`,
    ]);
  });
});

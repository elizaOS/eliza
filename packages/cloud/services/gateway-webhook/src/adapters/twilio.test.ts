/**
 * Exercises Twilio webhook normalization and outbound channel addressing with
 * deterministic SMS payloads while mocking the Twilio REST edge.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  calculateTwilioSmsBilling,
  DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
} from "../billing";
import { logger } from "../logger";
import { twilioAdapter } from "./twilio";
import type { ChatEvent, WebhookConfig } from "./types";

const originalFetch = globalThis.fetch;
const originalCostEnv = process.env.TWILIO_SMS_COST_PER_SEGMENT_USD;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCostEnv === undefined) {
    delete process.env.TWILIO_SMS_COST_PER_SEGMENT_USD;
  } else {
    process.env.TWILIO_SMS_COST_PER_SEGMENT_USD = originalCostEnv;
  }
  mock.restore();
});

describe("Twilio adapter channel addressing", () => {
  test("rejects Twilio-hosted WhatsApp payloads", async () => {
    const rawBody = new URLSearchParams({
      MessageSid: "SM_whatsapp_inbound",
      AccountSid: "AC_test",
      From: "whatsapp:+15551234567",
      To: "whatsapp:+14155238886",
      Body: "hello from WhatsApp",
      ProfileName: "Ada",
      WaId: "15551234567",
    }).toString();

    const event = await twilioAdapter.extractEvent(rawBody);

    expect(event).toBeNull();
  });

  test("bills malformed SMS cost config at the fallback and warns", async () => {
    // Prefix-numeric value the old lenient Number.parseFloat truncated to 0.5.
    process.env.TWILIO_SMS_COST_PER_SEGMENT_USD = "0.5USD";
    globalThis.fetch = mock(async () =>
      Response.json({ sid: "SM_sms_reply" }),
    ) as unknown as typeof fetch;
    const warnSpy = spyOn(logger, "warn");
    const infoSpy = spyOn(logger, "info");

    const config: WebhookConfig = {
      accountSid: "AC_test",
      authToken: "twilio-secret",
      phoneNumber: "+15550000000",
    };
    const event: ChatEvent = {
      platform: "twilio",
      messageId: "SM_sms_inbound",
      chatId: "+15551234567",
      senderId: "+15551234567",
      text: "hello from SMS",
      rawPayload: {},
    };
    // Two segments so the fallback vs. truncated cost differ unambiguously.
    const reply = "x".repeat(200);

    await twilioAdapter.sendReply(config, event, reply);

    expect(warnSpy).toHaveBeenCalledWith(
      "Invalid TWILIO_SMS_COST_PER_SEGMENT_USD; falling back to default",
      { raw: "0.5USD" },
    );

    const fallbackBreakdown = calculateTwilioSmsBilling(
      reply,
      DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
    );
    const truncatedBreakdown = calculateTwilioSmsBilling(reply, 0.5);
    expect(fallbackBreakdown.rawCost).not.toBe(truncatedBreakdown.rawCost);

    const recorded = infoSpy.mock.calls.find(
      ([message]) => message === "[TwilioAdapter] Outbound SMS cost recorded",
    );
    if (!recorded) throw new Error("Expected an outbound SMS cost log line");
    const context = recorded[1] as { rawCost: number };
    expect(context).toMatchObject({
      segments: fallbackBreakdown.segments,
      rawCost: fallbackBreakdown.rawCost,
      billedCost: fallbackBreakdown.billedCost,
      markup: fallbackBreakdown.markup,
    });
    expect(context.rawCost).not.toBe(truncatedBreakdown.rawCost);
  });

  test("bills valid SMS cost config without warning", async () => {
    process.env.TWILIO_SMS_COST_PER_SEGMENT_USD = "0.02";
    globalThis.fetch = mock(async () =>
      Response.json({ sid: "SM_sms_reply" }),
    ) as unknown as typeof fetch;
    const warnSpy = spyOn(logger, "warn");
    const infoSpy = spyOn(logger, "info");

    const reply = "x".repeat(200);
    await twilioAdapter.sendReply(
      {
        accountSid: "AC_test",
        authToken: "twilio-secret",
        phoneNumber: "+15550000000",
      },
      {
        platform: "twilio",
        messageId: "SM_sms_inbound",
        chatId: "+15551234567",
        senderId: "+15551234567",
        text: "hello",
        rawPayload: {},
      },
      reply,
    );

    expect(warnSpy).not.toHaveBeenCalled();
    const expected = calculateTwilioSmsBilling(reply, 0.02);
    const recorded = infoSpy.mock.calls.find(
      ([message]) => message === "[TwilioAdapter] Outbound SMS cost recorded",
    );
    if (!recorded) throw new Error("Expected an outbound SMS cost log line");
    expect(recorded[1]).toMatchObject({
      rawCost: expected.rawCost,
      billedCost: expected.billedCost,
    });
  });

  test("keeps SMS sender identities and reply addresses unchanged", async () => {
    const rawBody = new URLSearchParams({
      MessageSid: "SM_sms_inbound",
      AccountSid: "AC_test",
      From: "+15551234567",
      To: "+15550000000",
      Body: "hello from SMS",
    }).toString();
    const event = await twilioAdapter.extractEvent(rawBody);
    expect(event?.senderId).toBe("+15551234567");
    if (!event) throw new Error("Expected a valid SMS event");

    let requestBody: URLSearchParams | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      requestBody = new URLSearchParams(String(init?.body));
      return Response.json({ sid: "SM_sms_reply" });
    }) as unknown as typeof fetch;

    await twilioAdapter.sendReply(
      {
        accountSid: "AC_test",
        authToken: "twilio-secret",
        phoneNumber: "+15550000000",
      },
      event,
      "hello from Eliza",
    );

    expect(requestBody?.get("To")).toBe("+15551234567");
    expect(requestBody?.get("From")).toBe("+15550000000");
  });
});

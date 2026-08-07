/**
 * Exercises Twilio webhook normalization and outbound channel addressing with
 * deterministic SMS and WhatsApp payloads while mocking the Twilio REST edge.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { twilioAdapter } from "./twilio";
import type { ChatEvent, WebhookConfig } from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("Twilio adapter channel addressing", () => {
  test("normalizes a WhatsApp sender for phone identity resolution", async () => {
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

    expect(event).toMatchObject({
      platform: "twilio",
      messageId: "SM_whatsapp_inbound",
      chatId: "whatsapp:+15551234567",
      senderId: "+15551234567",
      senderName: "Ada",
      text: "hello from WhatsApp",
    });
  });

  test("restores the WhatsApp prefix when replying through a WhatsApp sender", async () => {
    let requestBody: URLSearchParams | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      requestBody = new URLSearchParams(String(init?.body));
      return Response.json({ sid: "SM_whatsapp_reply" });
    }) as unknown as typeof fetch;

    const config: WebhookConfig = {
      agentId: "public-onboarding-agent",
      accountSid: "AC_test",
      authToken: "twilio-secret",
      phoneNumber: "whatsapp:+14155238886",
    };
    const event: ChatEvent = {
      platform: "twilio",
      messageId: "SM_whatsapp_inbound",
      chatId: "whatsapp:+15551234567",
      senderId: "+15551234567",
      text: "hello from WhatsApp",
      rawPayload: {},
    };

    await twilioAdapter.sendReply(config, event, "hello from Eliza");

    expect(requestBody?.get("To")).toBe("whatsapp:+15551234567");
    expect(requestBody?.get("From")).toBe("whatsapp:+14155238886");
    expect(requestBody?.get("Body")).toBe("hello from Eliza");
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
        agentId: "public-onboarding-agent",
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

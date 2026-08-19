/** Verifies webhook authentication binds signed events to the configured tenant account. */

import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { twilioAdapter } from "./twilio";
import { whatsappAdapter } from "./whatsapp";

function twilioRequest(accountSid: string, configuredAccountSid: string) {
  const url = "https://gateway.test/webhook/project/twilio";
  const body = new URLSearchParams({
    MessageSid: "SM1",
    AccountSid: accountSid,
    From: "+15551112222",
    To: "+15550000000",
    Body: "hello",
  });
  const token = "auth-token";
  const signature = crypto
    .createHmac("sha1", token)
    .update(
      `${url}${[...body.keys()]
        .sort()
        .map((key) => `${key}${body.get(key)}`)
        .join("")}`,
    )
    .digest("base64");
  return twilioAdapter.verifyWebhook(
    new Request(url, {
      method: "POST",
      headers: { "x-twilio-signature": signature },
      body: body.toString(),
    }),
    body.toString(),
    {
      accountSid: configuredAccountSid,
      authToken: token,
      phoneNumber: "+15550000000",
    },
  );
}

function whatsappPayload(phoneNumberId: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "business",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+15550000000",
                phone_number_id: phoneNumberId,
              },
              messages: [
                {
                  id: "wamid-1",
                  from: "15551112222",
                  timestamp: "1",
                  type: "text",
                  text: { body: "hello" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

describe("gateway connector account ownership", () => {
  test("Twilio rejects a validly signed event from another account", async () => {
    expect(await twilioRequest("AC_other", "AC_owner")).toBe(false);
    expect(await twilioRequest("AC_owner", "AC_owner")).toBe(true);
  });

  test("WhatsApp rejects a validly signed event for another phone-number account", async () => {
    const secret = "app-secret";
    const verify = async (phoneNumberId: string) => {
      const body = whatsappPayload(phoneNumberId);
      const signature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");
      return whatsappAdapter.verifyWebhook(
        new Request("https://gateway.test/webhook/project/whatsapp", {
          method: "POST",
          headers: { "x-hub-signature-256": `sha256=${signature}` },
          body,
        }),
        body,
        { appSecret: secret, phoneNumberId: "phone-owner" },
      );
    };
    expect(await verify("phone-other")).toBe(false);
    expect(await verify("phone-owner")).toBe(true);
  });

  test("dedupe scopes include project and connector account", () => {
    const event = {
      platform: "twilio",
      messageId: "SM1",
      chatId: "chat",
      senderId: "sender",
      text: "hello",
      rawPayload: {},
    } as const;
    expect(
      twilioAdapter.getDedupeScope?.(
        { accountSid: "AC1", phoneNumber: "+15550000000" },
        event,
        "tenant-a",
      ),
    ).toBe("project:tenant-a:account:+15550000000");
    expect(
      whatsappAdapter.getDedupeScope?.(
        { phoneNumberId: "phone-1" },
        { ...event, platform: "whatsapp" },
        "tenant-b",
      ),
    ).toBe("project:tenant-b:account:phone-1");
  });
});

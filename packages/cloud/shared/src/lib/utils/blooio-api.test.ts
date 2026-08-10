/**
 * Covers the current Blooio API origin, v2/v4 webhook normalization, and the
 * provider's documented five-minute signature replay window.
 */

import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { BLOOIO_API_BASE, parseBlooioWebhookEvent, verifyBlooioSignature } from "./blooio-api";

function signedHeader(body: string, secret: string, ageSeconds: number): string {
  const timestamp = Math.floor(Date.now() / 1000) - ageSeconds;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

describe("Blooio API contract", () => {
  test("uses the documented production API origin", () => {
    expect(BLOOIO_API_BASE).toBe("https://api.blooio.com/v2/api");
  });

  test("normalizes a v4 message envelope for the existing router", () => {
    const event = parseBlooioWebhookEvent({
      id: "evt_abc123",
      type: "message.received",
      created_at: 1_786_244_262_331,
      organization_id: "org_abc123",
      data: {
        id: "msg_abc123",
        sender: "+15551234567",
        recipient: "+15550001111",
        channel_address: "+15550001111",
        direction: "inbound",
        text: "hello",
        protocol: "imessage",
        attachments: [],
      },
    });

    expect(event).toEqual({
      event: "message.received",
      message_id: "msg_abc123",
      external_id: "+15551234567",
      internal_id: "+15550001111",
      sender: "+15551234567",
      text: "hello",
      attachments: [],
      protocol: "imessage",
      is_group: false,
      received_at: 1_786_244_262_331,
      timestamp: 1_786_244_262_331,
    });
  });

  test("accepts a delivery inside the documented 300-second window", async () => {
    const body = JSON.stringify({ event: "message.sent", message_id: "m1" });
    const secret = "whsec_test";

    await expect(
      verifyBlooioSignature(secret, signedHeader(body, secret, 200), body),
    ).resolves.toBe(true);
    await expect(
      verifyBlooioSignature(secret, signedHeader(body, secret, 301), body),
    ).resolves.toBe(false);
  });
});

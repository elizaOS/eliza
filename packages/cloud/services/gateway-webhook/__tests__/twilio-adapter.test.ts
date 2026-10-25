/** Twilio Network turns must carry the receiving phone, like Blooio turns do. */
import { describe, expect, test } from "bun:test";
import { twilioAdapter } from "../src/adapters/twilio";
import { turnRequestFor } from "../src/network-service";

function twilioBody(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    MessageSid: "SMtest123",
    AccountSid: "ACtest123",
    From: "+14155550199",
    To: "+14155550022",
    Body: "Show my Friends profile",
    ...overrides,
  }).toString();
}

describe("twilio adapter Network turns", () => {
  test("extractEvent keeps the receiving number and turnRequestFor routes by it", async () => {
    const event = await twilioAdapter.extractEvent(twilioBody());
    if (!event) throw new Error("expected a Twilio event");
    expect(event.receivingNumber).toBe("+14155550022");
    const turn = turnRequestFor({
      ...event,
      gatewayReceivedAtMs: Date.now(),
    });
    expect(turn.channel).toBe("twilio");
    expect(turn.from).toBe("+14155550199");
    expect(turn.to).toBe("+14155550022");
  });

  test("WhatsApp-style addresses normalize to E.164 for the receiving line", async () => {
    const event = await twilioAdapter.extractEvent(
      twilioBody({
        From: "whatsapp:+14155550199",
        To: "whatsapp:+14155550022",
      }),
    );
    if (!event) throw new Error("expected a Twilio event");
    expect(event.receivingNumber).toBe("+14155550022");
    expect(event.senderId).toBe("+14155550199");
  });
});

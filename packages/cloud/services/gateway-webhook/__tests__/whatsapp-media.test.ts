/**
 * The Eliza App WhatsApp number goes through the gateway adapter. A photo,
 * voice note or document is a real message: the event must reach the agent
 * with the caption and a note of what was sent (as the org WhatsApp webhook
 * does), not be dropped with no reply. Real adapter, Meta payload shapes.
 */
import { describe, expect, test } from "bun:test";
import { whatsappAdapter } from "../src/adapters/whatsapp";

function delivery(message: Record<string, unknown>): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550000002",
                phone_number_id: "PNID",
              },
              contacts: [{ profile: { name: "Ana" }, wa_id: "15550000001" }],
              messages: [
                {
                  id: "wamid.1",
                  from: "15550000001",
                  timestamp: "1760000000",
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

describe("gateway WhatsApp media messages", () => {
  test("a captioned photo reaches the agent with its caption and a photo note", async () => {
    const event = await whatsappAdapter.extractEvent(
      delivery({
        type: "image",
        image: {
          id: "MEDIA1",
          mime_type: "image/jpeg",
          caption: "what is this rash?",
        },
      }),
    );
    expect(event?.text).toBe(
      "what is this rash?\n[The user sent a photo on WhatsApp. This connector cannot open WhatsApp media yet.]",
    );
    expect(event?.chatId).toBe("15550000001");
  });

  test("a voice note reaches the agent instead of being dropped", async () => {
    const event = await whatsappAdapter.extractEvent(
      delivery({
        type: "audio",
        audio: { id: "MEDIA2", mime_type: "audio/ogg" },
      }),
    );
    expect(event?.text).toBe(
      "[The user sent a voice note on WhatsApp. This connector cannot open WhatsApp media yet.]",
    );
  });

  test("a document keeps its file name", async () => {
    const event = await whatsappAdapter.extractEvent(
      delivery({
        type: "document",
        document: { id: "MEDIA3", filename: "invoice.pdf" },
      }),
    );
    expect(event?.text).toBe(
      '[The user sent a document ("invoice.pdf") on WhatsApp. This connector cannot open WhatsApp media yet.]',
    );
  });

  test("text messages are unchanged and other types are still skipped", async () => {
    const text = await whatsappAdapter.extractEvent(
      delivery({ type: "text", text: { body: "hello" } }),
    );
    expect(text?.text).toBe("hello");
    expect(
      await whatsappAdapter.extractEvent(delivery({ type: "location" })),
    ).toBeNull();
  });
});

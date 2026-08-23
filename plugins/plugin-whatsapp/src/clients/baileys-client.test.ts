/**
 * Exercises the personal WhatsApp client's real Baileys send boundary with a
 * deterministic socket seam, including exact native quote reconstruction and
 * rejection of success-shaped sends that lack an authoritative provider id.
 */
import { describe, expect, it, vi } from "vitest";
import { BaileysClient } from "./baileys-client";

function clientWithSocket(sendMessage: ReturnType<typeof vi.fn>): BaileysClient {
  const client = new BaileysClient({ authDir: "/tmp/whatsapp-client-quote-test" });
  (client as unknown as { connection: { getSocket: () => unknown } }).connection.getSocket =
    () => ({ sendMessage });
  return client;
}

describe("BaileysClient quoted delivery", () => {
  it("sends exact group participant, direction, and document payload context", async () => {
    const sendMessage = vi.fn(async () => ({ key: { id: "wamid.sent" } }));
    const client = clientWithSocket(sendMessage);

    await expect(
      client.sendMessage({
        type: "text",
        to: "120363000000@g.us",
        content: "reply",
        replyToMessageId: "wamid.document",
        replyToParticipant: "+1 (415) 555-2671",
        replyToFromMe: true,
        replyToType: "document",
        replyToText: "quarterly report",
      })
    ).resolves.toMatchObject({ messages: [{ id: "wamid.sent" }] });

    expect(sendMessage).toHaveBeenCalledWith(
      "120363000000@g.us",
      { text: "reply" },
      {
        quoted: {
          key: {
            remoteJid: "120363000000@g.us",
            id: "wamid.document",
            fromMe: true,
            participant: "14155552671@s.whatsapp.net",
          },
          message: { documentMessage: { caption: "quarterly report" } },
        },
      }
    );
  });

  it("rejects a send without an authoritative WhatsApp message id", async () => {
    const client = clientWithSocket(vi.fn(async () => ({ key: {} })));

    await expect(
      client.sendMessage({ type: "text", to: "+14155552671", content: "hello" })
    ).rejects.toMatchObject({
      code: "WHATSAPP_PROVIDER_MESSAGE_ID_MISSING",
      context: {
        to: "14155552671@s.whatsapp.net",
        messageType: "text",
      },
    });
  });
});

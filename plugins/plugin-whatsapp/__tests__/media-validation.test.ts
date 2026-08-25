/**
 * Guards Cloud media URLs and proves the personal Baileys adapter requires
 * connector-verified canonical bytes instead of initiating its own download.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageAdapter } from "../src/baileys/message-adapter";
import { WhatsAppClient } from "../src/client";

describe("WhatsApp media URL validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["file:///etc/passwd", "data:text/plain,hello", "javascript:alert(1)", "notaurl"])(
    "rejects hostile Cloud API media links: %s",
    async (link) => {
      const client = new WhatsAppClient({
        accessToken: "token",
        phoneNumberId: "phone-id",
      });

      await expect(client.sendImage("+14155552671", link)).rejects.toThrow(
        "image message requires a valid http(s) media link"
      );
    }
  );

  it("rejects media links with embedded credentials", async () => {
    const client = new WhatsAppClient({
      accessToken: "token",
      phoneNumberId: "phone-id",
    });

    await expect(
      client.sendDocument("+14155552671", "https://user:pass@example.com/a.pdf")
    ).rejects.toThrow("document message requires a valid http(s) media link");
  });

  it("sends normalized http(s) media links", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messaging_product: "whatsapp",
            contacts: [{ input: "+14155552671", wa_id: "14155552671" }],
            messages: [{ id: "wamid.media" }],
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new WhatsAppClient({
      accessToken: "token",
      phoneNumberId: "phone-id",
    });

    await client.sendImage("+14155552671", " https://example.com/image.png ");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v24.0/phone-id/messages",
      expect.objectContaining({
        body: expect.stringContaining('"link":"https://example.com/image.png"'),
      })
    );
  });

  it.each(["file:///tmp/secret.jpg", "https://example.com/a.mp3"])(
    "rejects Baileys media links without canonical bytes: %s",
    (link) => {
    const adapter = new MessageAdapter();

    expect(() =>
      adapter.toBaileys({
        type: "audio",
        to: "14155552671@s.whatsapp.net",
        content: { link },
      })
    ).toThrow("requires canonical local bytes");
    }
  );

  it("passes exact canonical bytes to Baileys without a URL payload", () => {
    const adapter = new MessageAdapter();
    const bytes = new Uint8Array([1, 2, 3]);
    expect(
      adapter.toBaileys({
        type: "audio",
        to: "14155552671@s.whatsapp.net",
        content: { link: "/api/media/hash.mp3", bytes },
      })
    ).toEqual({ audio: Buffer.from(bytes) });
  });
});

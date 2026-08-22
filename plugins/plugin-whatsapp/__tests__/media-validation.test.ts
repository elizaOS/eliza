/**
 * Proves WhatsApp media is staged through core's real SSRF guard before Baileys
 * receives bytes; DNS and redirect transport are deterministic test seams.
 */
import { describe, expect, it, vi } from "vitest";
import { MessageAdapter } from "../src/baileys/message-adapter";
import { stageWhatsAppMedia } from "../src/media";

describe("WhatsApp guarded media staging", () => {
  it.each([
    "file:///tmp/secret.jpg",
    "http://127.0.0.1/private",
    "http://169.254.169.254/latest/meta-data",
  ])("rejects a hostile literal target before transport: %s", async (url) => {
    const pinnedFetchImpl = vi.fn(async () => new Response(Buffer.from("secret")));

    await expect(stageWhatsAppMedia(url, { pinnedFetchImpl })).rejects.toMatchObject({
      code: "fetch_failed",
    });
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a public hostname whose DNS answer is private", async () => {
    const pinnedFetchImpl = vi.fn(async () => new Response(Buffer.from("secret")));

    await expect(
      stageWhatsAppMedia("https://media.example.test/photo.jpg", {
        lookupFn: async () => [{ address: "10.0.0.7", family: 4 }],
        pinnedFetchImpl,
      })
    ).rejects.toMatchObject({ code: "fetch_failed" });
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("revalidates and rejects a redirect to a private address", async () => {
    const pinnedFetchImpl = vi.fn(async () =>
      Response.redirect("http://127.0.0.1/private", 302)
    );

    await expect(
      stageWhatsAppMedia("https://media.example.test/photo.jpg", {
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
        pinnedFetchImpl,
      })
    ).rejects.toMatchObject({ code: "fetch_failed" });
    expect(pinnedFetchImpl).toHaveBeenCalledTimes(1);
  });

  it("hands only staged bytes to the Baileys adapter", () => {
    const adapter = new MessageAdapter();
    expect(() =>
      adapter.toBaileys({
        type: "image",
        to: "14155552671@s.whatsapp.net",
        content: { link: "https://example.test/photo.jpg" },
      })
    ).toThrow("requires media bytes staged through the guarded fetch path");

    expect(
      adapter.toBaileys({
        type: "image",
        to: "14155552671@s.whatsapp.net",
        content: { data: Buffer.from("image") },
      })
    ).toEqual({ image: Buffer.from("image") });
  });
});

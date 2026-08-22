/**
 * Exercises the Baileys send boundary with a deterministic socket, ensuring a
 * provider response without its authoritative message id cannot look successful.
 */
import { describe, expect, it, vi } from "vitest";
import { BaileysClient } from "./baileys-client";

describe("BaileysClient send response", () => {
  it("fails when Baileys omits the authoritative message id", async () => {
    const client = Object.create(BaileysClient.prototype) as BaileysClient;
    (client as unknown as { connection: unknown }).connection = {
      getSocket: () => ({ sendMessage: vi.fn(async () => ({ key: {} })) }),
    };
    (client as unknown as { adapter: unknown }).adapter = {
      toBaileys: () => ({ text: "hello" }),
    };

    await expect(
      client.sendMessage({ type: "text", to: "14155552671@s.whatsapp.net", content: "hello" })
    ).rejects.toThrow("without a WhatsApp message id");
  });
});

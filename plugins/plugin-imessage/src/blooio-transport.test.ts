/**
 * Exercises Blooio signature, channel-isolation, parsing, and outbound receipt contracts.
 */

import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseBlooioInbound,
  sendBlooioMessage,
  verifyBlooioSignature,
} from "./blooio-transport.js";

const SECRET = "whsec_test";
const NOW = 1_800_000_000;

function envelope(channelId = "ch_bettina"): string {
  return JSON.stringify({
    id: "evt_1",
    type: "message.received",
    created_at: NOW * 1000,
    data: {
      id: "msg_1",
      chat_id: "chat_1",
      channel_id: channelId,
      channel_type: "blooio",
      sender: "+15551234567",
      recipient: "+12692921765",
      text: "hello",
      attachments: ["https://media.blooio.com/a.jpg", "https://evil.example/a.jpg"],
    },
  });
}

function sign(body: string, timestamp = NOW): string {
  const digest = crypto.createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

afterEach(() => vi.unstubAllGlobals());

describe("Blooio iMessage transport", () => {
  it("accepts a fresh authentic signature and rejects tampering or replay", () => {
    const body = envelope();
    expect(verifyBlooioSignature(SECRET, sign(body), body, NOW)).toBe(true);
    expect(verifyBlooioSignature(SECRET, sign(body), `${body} `, NOW)).toBe(false);
    expect(verifyBlooioSignature(SECRET, sign(body, NOW - 301), body, NOW)).toBe(false);
  });

  it("dispatches only the configured channel and retains trusted Blooio media", () => {
    expect(parseBlooioInbound(envelope("ch_shared"), "ch_bettina")).toBeNull();
    expect(parseBlooioInbound(envelope(), "ch_bettina")).toMatchObject({
      messageId: "msg_1",
      sender: "+15551234567",
      channelId: "ch_bettina",
      mediaUrls: ["https://media.blooio.com/a.jpg"],
    });
  });

  it("sends through v4 with the selected channel and requires a receipt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_out" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      sendBlooioMessage({
        apiKey: "api_test",
        from: "ch_bettina",
        to: "+15551234567",
        text: "reply",
        idempotencyKey: "reply-msg-1",
      })
    ).resolves.toEqual({ success: true, messageId: "msg_out", chatId: "+15551234567" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.blooio.com/v4/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ to: "+15551234567", from: "ch_bettina", text: "reply" }),
      })
    );
  });

  it("replies to v4 groups through their chat resource", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ message_id: "msg_group_out" }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      sendBlooioMessage({
        apiKey: "api_test",
        from: "ch_bettina",
        to: "chat_id:chat_group",
        text: "group reply",
        idempotencyKey: "reply-group-1",
      })
    ).resolves.toEqual({ success: true, messageId: "msg_group_out", chatId: "chat_group" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.blooio.com/v4/chats/chat_group/messages",
      expect.objectContaining({ body: JSON.stringify({ text: "group reply" }) })
    );
  });
});

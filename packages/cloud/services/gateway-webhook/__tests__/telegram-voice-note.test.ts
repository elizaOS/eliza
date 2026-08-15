/** Verifies Telegram voice-note parsing and credential-local bounded downloads. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { telegramAdapter } from "../src/adapters/telegram";

const originalFetch = globalThis.fetch;

function update(voice: Record<string, unknown>) {
  return JSON.stringify({
    update_id: 101,
    message: {
      message_id: 7,
      from: { id: 42, first_name: "Ada" },
      chat: { id: 42, type: "private" },
      voice,
    },
  });
}

describe("Telegram voice notes", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("accepts a captionless private Ogg voice note", async () => {
    const event = await telegramAdapter.extractEvent(
      update({
        file_id: "voice-file-1",
        duration: 3,
        mime_type: "audio/ogg",
        file_size: 8,
      }),
    );
    expect(event).toMatchObject({
      messageId: "101",
      text: "",
      voiceNote: {
        fileId: "voice-file-1",
        durationSeconds: 3,
        sizeBytes: 8,
        mimeType: "audio/ogg",
      },
    });
  });

  test("rejects provider metadata beyond the stricter product byte limit", async () => {
    const event = await telegramAdapter.extractEvent(
      update({
        file_id: "voice-file-1",
        duration: 3,
        file_size: 8 * 1024 * 1024 + 1,
      }),
    );
    expect(event).toBeNull();
  });

  test("downloads through getFile without returning a token-bearing URL", async () => {
    const bytes = Buffer.from("OggSvoice");
    const urls: string[] = [];
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      urls.push(request.url);
      if (request.url.endsWith("/getFile")) {
        return Response.json({
          ok: true,
          result: { file_path: "voice/file_1.oga", file_size: bytes.length },
        });
      }
      return new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      });
    }) as typeof fetch;
    const event = await telegramAdapter.extractEvent(
      update({
        file_id: "voice-file-1",
        duration: 3,
        file_size: bytes.length,
      }),
    );
    if (!event) throw new Error("expected voice event");
    const resolved = await telegramAdapter.resolveVoiceNote?.(
      { botToken: "secret-token" },
      event,
    );
    expect(resolved).toEqual({
      bytesBase64: bytes.toString("base64"),
      mimeType: "audio/ogg",
      filename: "telegram-101.ogg",
      sizeBytes: bytes.length,
      durationSeconds: 3,
    });
    expect(JSON.stringify(resolved)).not.toContain("secret-token");
    expect(urls).toEqual([
      "https://api.telegram.org/botsecret-token/getFile",
      "https://api.telegram.org/file/botsecret-token/voice/file_1.oga",
    ]);
  });

  test("rejects getFile path traversal before a download request", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return Response.json({
        ok: true,
        result: { file_path: "../token-leak.ogg", file_size: 8 },
      });
    }) as typeof fetch;
    const event = await telegramAdapter.extractEvent(
      update({ file_id: "voice-file-1", duration: 3, file_size: 8 }),
    );
    if (!event) throw new Error("expected voice event");
    await expect(
      telegramAdapter.resolveVoiceNote?.({ botToken: "secret-token" }, event),
    ).rejects.toThrow("invalid file path");
    expect(calls).toBe(1);
  });

  test("rejects non-Ogg bytes even when Telegram reports audio", async () => {
    const bytes = Buffer.from("NOT-OGG!");
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/getFile")) {
        return Response.json({
          ok: true,
          result: { file_path: "voice/file_1.oga", file_size: bytes.length },
        });
      }
      return new Response(bytes);
    }) as typeof fetch;
    const event = await telegramAdapter.extractEvent(
      update({
        file_id: "voice-file-1",
        duration: 3,
        file_size: bytes.length,
      }),
    );
    if (!event) throw new Error("expected voice event");
    await expect(
      telegramAdapter.resolveVoiceNote?.({ botToken: "secret-token" }, event),
    ).rejects.toThrow("Ogg stream");
  });

  test("sanitizes a download transport error that contains the bot token URL", async () => {
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/getFile")) {
        return Response.json({
          ok: true,
          result: { file_path: "voice/file_1.oga", file_size: 8 },
        });
      }
      throw new Error(`network failure for ${request.url}`);
    }) as typeof fetch;
    const event = await telegramAdapter.extractEvent(
      update({ file_id: "voice-file-1", duration: 3, file_size: 8 }),
    );
    if (!event) throw new Error("expected voice event");

    const resolver = telegramAdapter.resolveVoiceNote;
    if (!resolver) throw new Error("expected Telegram voice resolver");
    const error = await resolver({ botToken: "secret-token" }, event).catch(
      (failure) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Telegram voice download transport failed",
    );
    expect((error as Error).message).not.toContain("secret-token");
  });
});

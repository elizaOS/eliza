/**
 * Voice storage integration tests exercise the real Discord attachment handler
 * with deterministic fetch boundaries.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Attachment } from "discord.js";
import { VoiceMessageHandler } from "../src/voice-message-handler";

// Store original env
const originalEnv = { ...process.env };

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "attachment-1",
    url: "https://cdn.discordapp.com/voice.ogg",
    size: 3,
    contentType: "audio/ogg",
    name: "voice message.ogg",
    ...overrides,
  } as Attachment;
}

describe("VoiceMessageHandler storage integration", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    mock.restore();
  });

  test("returns the Discord CDN URL when storage proxy config is absent", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.ELIZA_CLOUD_URL;
    const fetchMock = mock(async () => new Response(new Uint8Array([1, 2, 3])));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await new VoiceMessageHandler().processVoiceMessage(
      makeAttachment(),
      "connection-1",
      "message-1",
    );

    expect(result.audioUrl).toBe("https://cdn.discordapp.com/voice.ogg");
    expect(result.size).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("uploads voice audio through the storage proxy and returns a presigned URL", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "storage-token";
    process.env.ELIZA_CLOUD_URL = "https://cloud.example.test/";
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://cdn.discordapp.com/voice.ogg") {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "audio/ogg" },
        });
      }
      if (
        url ===
        "https://cloud.example.test/api/v1/apis/storage/objects/voice/connection-1/message-1/attachment-1-voice_message.ogg"
      ) {
        return Response.json(
          { key: "voice/key.ogg", size: 3 },
          { status: 201 },
        );
      }
      if (url === "https://cloud.example.test/api/v1/apis/storage/presign") {
        return Response.json({
          url: "https://r2.example.test/signed",
          expiresAt: "2026-06-02T19:00:00.000Z",
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await new VoiceMessageHandler().processVoiceMessage(
      makeAttachment(),
      "connection-1",
      "message-1",
    );

    expect(result).toEqual({
      audioUrl: "https://r2.example.test/signed",
      expiresAt: new Date("2026-06-02T19:00:00.000Z"),
      size: 3,
      contentType: "audio/ogg",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("cleanup deletes expired voice objects from storage", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "storage-token";
    process.env.ELIZA_CLOUD_URL = "https://cloud.example.test";
    const oldDate = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const recentDate = new Date().toISOString();
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url ===
        "https://cloud.example.test/api/v1/apis/storage/list?prefix=voice&recursive=true"
      ) {
        return Response.json({
          items: [
            { key: "voice/old.ogg", modifiedAt: oldDate },
            { key: "voice/recent.ogg", modifiedAt: recentDate },
          ],
        });
      }
      if (
        url ===
        "https://cloud.example.test/api/v1/apis/storage/objects/voice/old.ogg"
      ) {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(new VoiceMessageHandler().cleanupExpiredAudio()).resolves.toBe(
      1,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

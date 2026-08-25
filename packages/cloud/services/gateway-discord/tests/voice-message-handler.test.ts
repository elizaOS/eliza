/**
 * Voice storage integration tests exercise the real Discord attachment handler
 * with deterministic fetch boundaries.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Attachment } from "discord.js";
import { logger } from "../src/logger";
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
    const infoLog = spyOn(logger, "info");
    process.env.BLOB_READ_WRITE_TOKEN = "storage-token";
    process.env.ELIZA_CLOUD_URL = "https://cloud.example.test/";
    const fetchMock = mock(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === "https://cdn.discordapp.com/voice.ogg") {
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { "Content-Type": "audio/ogg" },
          });
        }
        if (
          url === "https://cloud.example.test/api/v1/apis/storage/objects/_"
        ) {
          return Response.json(
            { key: "voice/key.ogg", size: 3 },
            { status: 201 },
          );
        }
        if (url === "https://cloud.example.test/api/v1/apis/storage/presign") {
          return Response.json({
            url: "https://r2.example.test/signed",
            expiresAt: "2099-06-02T19:00:00.000Z",
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await new VoiceMessageHandler().processVoiceMessage(
      makeAttachment(),
      "connection-1",
      "message-1",
    );

    expect(result).toEqual({
      audioUrl: "https://r2.example.test/signed",
      expiresAt: new Date("2099-06-02T19:00:00.000Z"),
      size: 3,
      contentType: "audio/ogg",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const upload = fetchMock.mock.calls[1];
    expect(String(upload?.[0])).toBe(
      "https://cloud.example.test/api/v1/apis/storage/objects/_",
    );
    const uploadHeaders = new Headers(
      (upload?.[1] as RequestInit | undefined)?.headers,
    );
    expect(uploadHeaders.get("X-Storage-Object-Key")).toBe(
      "voice/connection-1/message-1/attachment-1-voice_message.ogg",
    );
    expect(uploadHeaders.get("Idempotency-Key")).toMatch(
      /^discord-voice:put:[0-9a-f]{64}$/,
    );
    expect(uploadHeaders.get("Content-Length")).toBe("3");
    expect(uploadHeaders.get("X-Content-Length")).toBe("3");
    expect(uploadHeaders.get("X-Content-SHA256")).toBe(
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    );
    const capturedLogs = JSON.stringify(infoLog.mock.calls);
    expect(capturedLogs).not.toContain("voice/connection-1");
    expect(capturedLogs).not.toContain("storage-token");
    expect(capturedLogs).not.toContain("Authorization");
    expect(capturedLogs).not.toContain("X-Storage-Object-Key");
  });

  test("replays one stable presign lineage key across arbitrarily many renewals", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "storage-token";
    process.env.ELIZA_CLOUD_URL = "https://cloud.example.test";
    let presignAttempts = 0;
    const presignKeys: string[] = [];
    const fetchMock = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://cdn.discordapp.com/voice.ogg") {
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { "Content-Type": "audio/ogg" },
          });
        }
        if (
          url === "https://cloud.example.test/api/v1/apis/storage/objects/_"
        ) {
          return Response.json(
            { key: "voice/key.ogg", size: 3 },
            { status: 201 },
          );
        }
        if (url === "https://cloud.example.test/api/v1/apis/storage/presign") {
          presignAttempts += 1;
          presignKeys.push(
            new Headers(init?.headers).get("Idempotency-Key") ?? "",
          );
          return Response.json({
            url: `https://blob.example/_storage/c/renewed-${presignAttempts}`,
            expiresAt: "2099-06-02T19:00:00.000Z",
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const handler = new VoiceMessageHandler();
    for (let generation = 1; generation <= 4; generation++) {
      const result = await handler.processVoiceMessage(
        makeAttachment(),
        "connection-1",
        "message-1",
      );
      expect(result.audioUrl).toBe(
        `https://blob.example/_storage/c/renewed-${generation}`,
      );
    }
    expect(presignAttempts).toBe(4);
    expect(new Set(presignKeys).size).toBe(1);
    expect(presignKeys[0]).toMatch(/^discord-voice:presign-3600:[0-9a-f]{64}$/);
  });

  test("cleanup deletes expired voice objects from storage", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "storage-token";
    process.env.ELIZA_CLOUD_URL = "https://cloud.example.test";
    const oldDate = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const recentDate = new Date().toISOString();
    const fetchMock = mock(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === "https://cloud.example.test/api/v1/apis/storage/list") {
          return Response.json({
            items: [
              { key: "voice/old.ogg", modifiedAt: oldDate },
              { key: "voice/recent.ogg", modifiedAt: recentDate },
            ],
          });
        }
        if (
          url === "https://cloud.example.test/api/v1/apis/storage/objects/_"
        ) {
          return new Response(null, { status: 204 });
        }
        return new Response("unexpected", { status: 500 });
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(new VoiceMessageHandler().cleanupExpiredAudio()).resolves.toBe(
      1,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const listRequest = fetchMock.mock.calls[0];
    const deleteRequest = fetchMock.mock.calls[1];
    expect(listRequest).toBeDefined();
    expect(deleteRequest).toBeDefined();
    const listHeaders = new Headers(
      (listRequest?.[1] as RequestInit | undefined)?.headers,
    );
    expect(listHeaders.get("X-Storage-Prefix")).toBe("voice");
    expect(listHeaders.get("Idempotency-Key")).toMatch(
      /^discord-voice:list:[0-9a-f]{64}$/,
    );
    const deleteHeaders = new Headers(
      (deleteRequest?.[1] as RequestInit | undefined)?.headers,
    );
    expect(deleteHeaders.get("X-Storage-Object-Key")).toBe("voice/old.ogg");
    expect(deleteHeaders.get("Idempotency-Key")).toMatch(
      /^discord-voice:delete:[0-9a-f]{64}$/,
    );
  });
});

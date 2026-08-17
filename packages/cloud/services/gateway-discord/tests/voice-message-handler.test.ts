/**
 * Voice storage integration tests exercise the real Discord attachment handler
 * with deterministic fetch boundaries.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Attachment } from "discord.js";

const loggerInfo = mock();
const loggerDebug = mock();
const loggerWarn = mock();
const loggerError = mock();

mock.module("../src/logger", () => ({
  logger: {
    info: loggerInfo,
    debug: loggerDebug,
    warn: loggerWarn,
    error: loggerError,
  },
}));

const { VoiceMessageHandler, computeVoiceCleanupSafetyMs, parseIntEnv } =
  await import("../src/voice-message-handler");

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
    loggerInfo.mockClear();
    loggerDebug.mockClear();
    loggerWarn.mockClear();
    loggerError.mockClear();
    mock.restore();
  });

  test("validates integer environment values against the provider contract", () => {
    const name = "VOICE_TEST_BOUNDED_INTEGER";
    delete process.env[name];
    expect(parseIntEnv(name, 600, 60, 3600)).toBe(600);

    process.env[name] = "60";
    expect(parseIntEnv(name, 600, 60, 3600)).toBe(60);
    process.env[name] = "3600";
    expect(parseIntEnv(name, 600, 60, 3600)).toBe(3600);

    for (const invalid of ["59", "3601", "1.5", "1e2", "not-a-number"]) {
      process.env[name] = invalid;
      expect(() => parseIntEnv(name, 600, 60, 3600)).toThrow(
        "expected an integer from 60 through 3600",
      );
    }

    expect(computeVoiceCleanupSafetyMs(1_000)).toBe(61_000);
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
    const serializedLogs = JSON.stringify([
      loggerInfo.mock.calls,
      loggerDebug.mock.calls,
      loggerWarn.mock.calls,
      loggerError.mock.calls,
    ]);
    for (const privateValue of [
      "voice/connection-1/message-1/attachment-1-voice_message.ogg",
      "https://r2.example.test/signed",
      "connection-1",
      "message-1",
      "attachment-1",
      "voice message.ogg",
    ]) {
      expect(serializedLogs).not.toContain(privateValue);
    }
    expect(loggerInfo).toHaveBeenCalledWith(
      "Uploaded voice attachment to managed storage",
      { size: 3, contentType: "audio/ogg" },
    );
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

  test("cleanup retains objects until the signed-URL safety window has elapsed", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "storage-token";
    process.env.ELIZA_CLOUD_URL = "https://cloud.example.test";
    const ttlMs = 3_600_000;
    const safetyMs = 15 * 60_000 + 2 * 30_000;
    const insideSafetyWindow = new Date(
      Date.now() - ttlMs - safetyMs + 1_000,
    ).toISOString();
    const outsideSafetyWindow = new Date(
      Date.now() - ttlMs - safetyMs - 1_000,
    ).toISOString();
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url ===
        "https://cloud.example.test/api/v1/apis/storage/list?prefix=voice&recursive=true"
      ) {
        return Response.json({
          items: [
            { key: "voice/still-valid.ogg", modifiedAt: insideSafetyWindow },
            { key: "voice/expired.ogg", modifiedAt: outsideSafetyWindow },
          ],
        });
      }
      if (
        url ===
        "https://cloud.example.test/api/v1/apis/storage/objects/voice/expired.ogg"
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
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("voice/still-valid.ogg"),
      ),
    ).toBe(false);
  });
});

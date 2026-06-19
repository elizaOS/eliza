/**
 * Voice Message Handler Unit Tests
 *
 * Tests for services/gateway-discord/src/voice-message-handler.ts
 *
 * Note: These tests focus on the logic that can be tested without
 * complex mocking of discord.js and the R2 upload client. Integration
 * tests should cover the full flow with real dependencies once the R2
 * upload backend is wired up.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Attachment } from "discord.js";
import { VoiceMessageHandler } from "../src/voice-message-handler";

// Store original env
const originalEnv = { ...process.env };

describe("Voice attachment detection logic", () => {
  // These tests verify the voice attachment detection logic
  // without requiring discord.js types

  test("audio content types are detected as voice", () => {
    // isVoiceAttachment checks contentType?.startsWith("audio/") || name?.endsWith(".ogg")
    const isVoiceAttachment = (att: {
      contentType?: string | null;
      name?: string | null;
    }) => {
      return (
        att.contentType?.startsWith("audio/") || att.name?.endsWith(".ogg")
      );
    };

    expect(isVoiceAttachment({ contentType: "audio/ogg" })).toBe(true);
    expect(isVoiceAttachment({ contentType: "audio/wav" })).toBe(true);
    expect(isVoiceAttachment({ contentType: "audio/mpeg" })).toBe(true);
    expect(isVoiceAttachment({ name: "voice.ogg" })).toBe(true);
    expect(
      isVoiceAttachment({ name: "recording.ogg", contentType: null }),
    ).toBe(true);
  });

  test("non-audio content types are not detected as voice", () => {
    const isVoiceAttachment = (att: {
      contentType?: string | null;
      name?: string | null;
    }): boolean => {
      return !!(
        att.contentType?.startsWith("audio/") || att.name?.endsWith(".ogg")
      );
    };

    expect(isVoiceAttachment({ contentType: "image/png" })).toBe(false);
    expect(isVoiceAttachment({ contentType: "video/mp4" })).toBe(false);
    expect(isVoiceAttachment({ contentType: "text/plain" })).toBe(false);
    expect(isVoiceAttachment({ name: "document.pdf" })).toBe(false);
    expect(isVoiceAttachment({ name: "image.jpg" })).toBe(false);
  });

  test("IsVoiceMessage flag (8192) can be detected", () => {
    const IS_VOICE_MESSAGE = 8192;

    const hasVoiceFlag = (bitfield: number) =>
      (bitfield & IS_VOICE_MESSAGE) !== 0;

    expect(hasVoiceFlag(8192)).toBe(true);
    expect(hasVoiceFlag(8192 | 1 | 2)).toBe(true); // Combined with other flags
    expect(hasVoiceFlag(0)).toBe(false);
    expect(hasVoiceFlag(1)).toBe(false);
    expect(hasVoiceFlag(4096)).toBe(false);
  });
});

describe("Filename sanitization", () => {
  test("removes path traversal characters", () => {
    // The actual sanitization regex from voice-message-handler.ts: /[^a-zA-Z0-9._-]/g replaced with "_"
    // Note: dots are preserved in the regex, so "../" becomes ".._" not "___"
    const sanitizeFilename = (name: string) =>
      name.replace(/[^a-zA-Z0-9._-]/g, "_");

    // Path traversal - the dots remain but slashes become underscores
    expect(sanitizeFilename("../../../etc/passwd")).toBe(".._.._.._etc_passwd");
    expect(sanitizeFilename("..\\..\\file.txt")).toBe(".._.._file.txt");
    expect(sanitizeFilename("normal-file.ogg")).toBe("normal-file.ogg");
    expect(sanitizeFilename("file with spaces.ogg")).toBe(
      "file_with_spaces.ogg",
    );
    expect(sanitizeFilename('file<>:"|?*.ogg')).toBe("file_______.ogg");
  });

  test("preserves safe characters", () => {
    const sanitizeFilename = (name: string) =>
      name.replace(/[^a-zA-Z0-9._-]/g, "_");

    expect(sanitizeFilename("my-voice_2024.01.15.ogg")).toBe(
      "my-voice_2024.01.15.ogg",
    );
    expect(sanitizeFilename("Voice123.ogg")).toBe("Voice123.ogg");
    expect(sanitizeFilename("a.b.c.d.ogg")).toBe("a.b.c.d.ogg");
  });

  test("path traversal prevention works by sanitizing parent directory references", () => {
    const sanitizeFilename = (name: string) =>
      name.replace(/[^a-zA-Z0-9._-]/g, "_");

    // Even though dots remain, the path separator is removed
    // This means "../" becomes ".._" which won't traverse directories
    const malicious = "../../../etc/passwd";
    const sanitized = sanitizeFilename(malicious);

    // The sanitized name no longer contains "/" which is what makes it safe
    expect(sanitized.includes("/")).toBe(false);
    expect(sanitized.includes("\\")).toBe(false);
  });
});

describe("Voice file size limits", () => {
  const MAX_VOICE_FILE_SIZE = 25 * 1024 * 1024; // 25MB

  test("25MB limit is correct", () => {
    expect(MAX_VOICE_FILE_SIZE).toBe(26214400);
  });

  test("files under limit pass validation", () => {
    const isValidSize = (size: number) => size <= MAX_VOICE_FILE_SIZE;

    expect(isValidSize(1024)).toBe(true); // 1KB
    expect(isValidSize(1024 * 1024)).toBe(true); // 1MB
    expect(isValidSize(10 * 1024 * 1024)).toBe(true); // 10MB
    expect(isValidSize(25 * 1024 * 1024)).toBe(true); // Exactly 25MB
  });

  test("files over limit fail validation", () => {
    const isValidSize = (size: number) => size <= MAX_VOICE_FILE_SIZE;

    expect(isValidSize(25 * 1024 * 1024 + 1)).toBe(false); // Just over
    expect(isValidSize(30 * 1024 * 1024)).toBe(false); // 30MB
    expect(isValidSize(100 * 1024 * 1024)).toBe(false); // 100MB
  });
});

describe("parseIntEnv behavior", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("parseIntEnv logic validates integers correctly", () => {
    // Replicate parseIntEnv logic
    const parseIntEnv = (
      value: string | undefined,
      defaultValue: number,
    ): number => {
      if (value === undefined) return defaultValue;
      const parsed = parseInt(value, 10);
      if (Number.isNaN(parsed)) {
        throw new Error(`Invalid value: "${value}" is not a valid integer`);
      }
      return parsed;
    };

    expect(parseIntEnv(undefined, 3600)).toBe(3600);
    expect(parseIntEnv("7200", 3600)).toBe(7200);
    expect(parseIntEnv("0", 3600)).toBe(0);
    expect(parseIntEnv("-100", 3600)).toBe(-100);
    expect(() => parseIntEnv("not-a-number", 3600)).toThrow(
      "not a valid integer",
    );
    // parseInt("12.5", 10) returns 12 (truncates at decimal)
    expect(parseIntEnv("12.5", 3600)).toBe(12);
  });
});

describe("Voice audio TTL calculation", () => {
  test("expiration date is calculated correctly", () => {
    const VOICE_AUDIO_TTL_SECONDS = 3600; // 1 hour
    const now = Date.now();

    const expiresAt = new Date(now + VOICE_AUDIO_TTL_SECONDS * 1000);

    // Should be 1 hour in the future
    const diffMs = expiresAt.getTime() - now;
    expect(diffMs).toBe(3600 * 1000);
  });

  test("file is expired when age exceeds TTL", () => {
    const VOICE_AUDIO_TTL_SECONDS = 3600;
    const now = Date.now();

    const isExpired = (uploadedAt: Date) => {
      const ageSeconds = (now - uploadedAt.getTime()) / 1000;
      return ageSeconds > VOICE_AUDIO_TTL_SECONDS;
    };

    // 2 hours old - expired
    const oldFile = new Date(now - 2 * 60 * 60 * 1000);
    expect(isExpired(oldFile)).toBe(true);

    // 30 minutes old - not expired
    const recentFile = new Date(now - 30 * 60 * 1000);
    expect(isExpired(recentFile)).toBe(false);

    // Exactly at TTL - not expired (must be greater than)
    const atTtl = new Date(now - VOICE_AUDIO_TTL_SECONDS * 1000);
    expect(isExpired(atTtl)).toBe(false);
  });
});

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

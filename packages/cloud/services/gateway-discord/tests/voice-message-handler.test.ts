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
const VOICE_OBJECT_KEY =
  "voice/connection-1/message-1/attachment-1-voice_message.ogg";
const RECEIPT_ID = "00000000-0000-4000-8000-000000021100";
const BASE_IDEMPOTENCY_KEY =
  "discord-voice-storage-presign-v1:a1927b63a8c73c4ebd4b36da2275f39ceda4effdf40e8da40b3356b2d3a6203b";
const RENEWAL_IDEMPOTENCY_KEY =
  "discord-voice-storage-presign-v1:09f02e3be3f4fd77a3484798fd71b50736c1f3dfe66df330327a00d9f490fccd";

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

    expect(computeVoiceCleanupSafetyMs(1_000)).toBe(91_000);
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
    const presignCall = fetchMock.mock.calls.find(
      ([input]) =>
        String(input) ===
        "https://cloud.example.test/api/v1/apis/storage/presign",
    );
    expect(presignCall).toBeDefined();
    const presignHeaders = new Headers(presignCall?.[1]?.headers);
    const idempotencyKey = presignHeaders.get("Idempotency-Key");
    expect(idempotencyKey).toBe(BASE_IDEMPOTENCY_KEY);
    expect(presignCall?.[1]?.method).toBe("POST");
    expect(presignHeaders.get("Authorization")).toBe("Bearer storage-token");
    expect(presignHeaders.get("X-API-Key")).toBe("storage-token");
    expect(JSON.parse(String(presignCall?.[1]?.body))).toEqual({
      key: VOICE_OBJECT_KEY,
      operation: "get",
      expiresIn: 3600,
    });
    for (const privateValue of [
      "connection-1",
      "message-1",
      "attachment-1",
      "voice_message.ogg",
    ]) {
      expect(idempotencyKey).not.toContain(privateValue);
    }
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

    await new VoiceMessageHandler().processVoiceMessage(
      makeAttachment(),
      "connection-1",
      "message-1",
    );
    const retryIdempotencyKeys = fetchMock.mock.calls
      .filter(
        ([input]) =>
          String(input) ===
          "https://cloud.example.test/api/v1/apis/storage/presign",
      )
      .map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));
    expect(retryIdempotencyKeys).toEqual([idempotencyKey, idempotencyKey]);
  });

  test("reuses deterministic base and renewal keys after a lost renewal response", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "storage-token";
    process.env.ELIZA_CLOUD_URL = "https://cloud.example.test";
    let presignAttempt = 0;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://cdn.discordapp.com/voice.ogg") {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "audio/ogg" },
        });
      }
      if (
        url ===
        `https://cloud.example.test/api/v1/apis/storage/objects/${VOICE_OBJECT_KEY}`
      ) {
        return Response.json({ key: "redacted", size: 3 }, { status: 201 });
      }
      if (url === "https://cloud.example.test/api/v1/apis/storage/presign") {
        presignAttempt += 1;
        if (presignAttempt === 1 || presignAttempt === 3) {
          return Response.json(
            {
              success: false,
              error: "Storage read receipt expired",
              code: "billing_state_conflict",
              details: { receiptId: RECEIPT_ID },
            },
            { status: 409 },
          );
        }
        if (presignAttempt === 2) {
          throw new Error("Renewal response lost");
        }
        return Response.json({
          url: "https://r2.example.test/renewed",
          expiresAt: "2026-06-02T19:00:00.000Z",
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const handler = new VoiceMessageHandler();
    await expect(
      handler.processVoiceMessage(
        makeAttachment(),
        "connection-1",
        "message-1",
      ),
    ).rejects.toThrow(/^Renewal response lost$/);

    await expect(
      handler.processVoiceMessage(
        makeAttachment(),
        "connection-1",
        "message-1",
      ),
    ).resolves.toEqual({
      audioUrl: "https://r2.example.test/renewed",
      expiresAt: new Date("2026-06-02T19:00:00.000Z"),
      size: 3,
      contentType: "audio/ogg",
    });

    const presignCalls = fetchMock.mock.calls.filter(
      ([input]) =>
        String(input) ===
        "https://cloud.example.test/api/v1/apis/storage/presign",
    );
    expect(presignCalls).toHaveLength(4);
    expect(
      presignCalls.map(([, init]) => ({
        method: init?.method,
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
        body: JSON.parse(String(init?.body)),
      })),
    ).toEqual([
      {
        method: "POST",
        idempotencyKey: BASE_IDEMPOTENCY_KEY,
        body: { key: VOICE_OBJECT_KEY, operation: "get", expiresIn: 3600 },
      },
      {
        method: "POST",
        idempotencyKey: RENEWAL_IDEMPOTENCY_KEY,
        body: { key: VOICE_OBJECT_KEY, operation: "get", expiresIn: 3600 },
      },
      {
        method: "POST",
        idempotencyKey: BASE_IDEMPOTENCY_KEY,
        body: { key: VOICE_OBJECT_KEY, operation: "get", expiresIn: 3600 },
      },
      {
        method: "POST",
        idempotencyKey: RENEWAL_IDEMPOTENCY_KEY,
        body: { key: VOICE_OBJECT_KEY, operation: "get", expiresIn: 3600 },
      },
    ]);
    for (const idempotencyKey of [
      BASE_IDEMPOTENCY_KEY,
      RENEWAL_IDEMPOTENCY_KEY,
    ]) {
      expect(idempotencyKey).toMatch(
        /^discord-voice-storage-presign-v1:[0-9a-f]{64}$/,
      );
      for (const privateValue of [
        "connection-1",
        "message-1",
        "attachment-1",
        "voice_message.ogg",
        RECEIPT_ID,
      ]) {
        expect(idempotencyKey).not.toContain(privateValue);
      }
    }
    const serializedLogs = JSON.stringify([
      loggerInfo.mock.calls,
      loggerDebug.mock.calls,
      loggerWarn.mock.calls,
      loggerError.mock.calls,
    ]);
    for (const privateValue of [
      VOICE_OBJECT_KEY,
      "connection-1",
      "message-1",
      "attachment-1",
      "voice message.ogg",
      RECEIPT_ID,
    ]) {
      expect(serializedLogs).not.toContain(privateValue);
    }
  });

  test("does not renew conflicts without one canonical expired receipt ID", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "storage-token";
    process.env.ELIZA_CLOUD_URL = "https://cloud.example.test";
    const conflicts = [
      {
        success: false,
        error: "Idempotency key conflict",
        code: "billing_state_conflict",
      },
      {
        success: false,
        error: "Receipt conflict",
        code: "billing_state_conflict",
        details: {
          receiptId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
        },
      },
      {
        success: false,
        error: "Receipt conflict",
        code: "billing_state_conflict",
        details: { receiptId: "voice/private-object.ogg" },
      },
    ];

    for (const conflict of conflicts) {
      const fetchMock = mock(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://cdn.discordapp.com/voice.ogg") {
          return new Response(new Uint8Array([1, 2, 3]));
        }
        if (
          url ===
          `https://cloud.example.test/api/v1/apis/storage/objects/${VOICE_OBJECT_KEY}`
        ) {
          return Response.json({ key: "redacted", size: 3 }, { status: 201 });
        }
        if (url === "https://cloud.example.test/api/v1/apis/storage/presign") {
          return Response.json(conflict, { status: 409 });
        }
        return new Response("unexpected", { status: 500 });
      });
      globalThis.fetch = fetchMock as typeof fetch;

      await expect(
        new VoiceMessageHandler().processVoiceMessage(
          makeAttachment(),
          "connection-1",
          "message-1",
        ),
      ).rejects.toThrow(/^Voice presign failed with status 409$/);

      const presignCalls = fetchMock.mock.calls.filter(
        ([input]) =>
          String(input) ===
          "https://cloud.example.test/api/v1/apis/storage/presign",
      );
      expect(presignCalls).toHaveLength(1);
      expect(
        new Headers(presignCalls[0]?.[1]?.headers).get("Idempotency-Key"),
      ).toBe(BASE_IDEMPOTENCY_KEY);
    }
  });

  test("fails closed after one renewal when the renewed request also conflicts", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "storage-token";
    process.env.ELIZA_CLOUD_URL = "https://cloud.example.test";
    let presignAttempt = 0;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://cdn.discordapp.com/voice.ogg") {
        return new Response(new Uint8Array([1, 2, 3]));
      }
      if (
        url ===
        `https://cloud.example.test/api/v1/apis/storage/objects/${VOICE_OBJECT_KEY}`
      ) {
        return Response.json({ key: "redacted", size: 3 }, { status: 201 });
      }
      if (url === "https://cloud.example.test/api/v1/apis/storage/presign") {
        presignAttempt += 1;
        return Response.json(
          {
            success: false,
            error: "Storage read receipt expired",
            code: "billing_state_conflict",
            details: {
              receiptId:
                presignAttempt === 1
                  ? RECEIPT_ID
                  : "00000000-0000-4000-8000-000000021101",
            },
          },
          { status: 409 },
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      new VoiceMessageHandler().processVoiceMessage(
        makeAttachment(),
        "connection-1",
        "message-1",
      ),
    ).rejects.toThrow(/^Voice presign failed with status 409$/);

    const presignCalls = fetchMock.mock.calls.filter(
      ([input]) =>
        String(input) ===
        "https://cloud.example.test/api/v1/apis/storage/presign",
    );
    expect(presignCalls).toHaveLength(2);
    expect(
      presignCalls.map(([, init]) =>
        new Headers(init?.headers).get("Idempotency-Key"),
      ),
    ).toEqual([BASE_IDEMPOTENCY_KEY, RENEWAL_IDEMPOTENCY_KEY]);
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
    const safetyMs = 15 * 60_000 + 3 * 30_000;
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

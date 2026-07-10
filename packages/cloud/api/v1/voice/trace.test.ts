/**
 * Unit coverage for cloud voice trace response headers.
 *
 * The v1 STT and TTS routes call these helpers for every practical response
 * path, so the route-level contract for trace echo and Server-Timing presence
 * is locked here without mocking provider, auth, billing, or cache services.
 */

import { describe, expect, it } from "bun:test";

import {
  MAX_VOICE_TRACE_ID_LENGTH,
  parseVoiceTraceId,
  readVoiceTraceId,
  VOICE_TRACE_HEADER,
  voiceJsonResponse,
  voiceTraceHeaders,
} from "./trace";

describe("parseVoiceTraceId (boundary validation, #15931)", () => {
  it("accepts a client-minted UUID (randomUUID shape)", () => {
    const uuid = "018f9f3a-7c2e-7b41-9a2d-6f0e1c2b3a4d";
    expect(parseVoiceTraceId(uuid)).toEqual({ traceId: uuid, invalid: false });
  });

  it("accepts the deterministic `voice-<t>-<r>` fallback shape", () => {
    const fallback = "voice-lz3k9q-847162";
    expect(parseVoiceTraceId(fallback)).toEqual({
      traceId: fallback,
      invalid: false,
    });
  });

  it("treats an absent header as absent, not invalid", () => {
    expect(parseVoiceTraceId(null)).toEqual({ traceId: null, invalid: false });
    expect(parseVoiceTraceId(undefined)).toEqual({
      traceId: null,
      invalid: false,
    });
    expect(parseVoiceTraceId("")).toEqual({ traceId: null, invalid: false });
  });

  it("rejects an oversized id (length bound)", () => {
    const oversized = "a".repeat(MAX_VOICE_TRACE_ID_LENGTH + 1);
    expect(parseVoiceTraceId(oversized)).toEqual({
      traceId: null,
      invalid: true,
    });
    // Exactly at the bound is still valid.
    const atBound = "a".repeat(MAX_VOICE_TRACE_ID_LENGTH);
    expect(parseVoiceTraceId(atBound)).toEqual({
      traceId: atBound,
      invalid: false,
    });
  });

  it("rejects CR/LF and header-injection shapes", () => {
    for (const hostile of [
      "abc\r\nX-Injected: 1",
      "abc\nSet-Cookie: x",
      "abc\rZ",
      "trace\u0000id", // NUL
      "trace\u0007id", // BEL / control char
      "trace id", // embedded space
      "trace\tid", // tab
    ]) {
      expect(parseVoiceTraceId(hostile)).toEqual({
        traceId: null,
        invalid: true,
      });
    }
  });

  it("rejects uppercase, unicode, and log-separator punctuation", () => {
    for (const bad of [
      "UPPER-case",
      "trace_id", // underscore not in charset
      "trace.id", // dot
      "trace=id", // key/value separator
      "trace;id", // Server-Timing separator
      "trace,id", // list separator
      'trace"id', // quote
      "tráce", // accented unicode
      "trace\u{1f600}", // emoji
    ]) {
      expect(parseVoiceTraceId(bad)).toEqual({ traceId: null, invalid: true });
    }
  });

  it("rejects leading/trailing/doubled hyphens (empty segments)", () => {
    for (const bad of ["-abc", "abc-", "a--b", "-", "--"]) {
      expect(parseVoiceTraceId(bad)).toEqual({ traceId: null, invalid: true });
    }
  });
});

describe("readVoiceTraceId (untrusted request boundary)", () => {
  it("returns the canonical id for a valid header", () => {
    const req = new Request("https://api.test/api/v1/voice/stt", {
      headers: { [VOICE_TRACE_HEADER]: "voice-lz3k9q-847162" },
    });
    expect(readVoiceTraceId(req)).toBe("voice-lz3k9q-847162");
  });

  it("observably ignores a malformed id (returns null, route proceeds)", () => {
    // A hostile header value must NOT reach logs or the echo path.
    const req = new Request("https://api.test/api/v1/voice/stt", {
      headers: { [VOICE_TRACE_HEADER]: "a".repeat(500) },
    });
    expect(readVoiceTraceId(req)).toBeNull();
  });
});

describe("voiceTraceHeaders echo boundary (defense in depth)", () => {
  it("never echoes a non-canonical id even if one is passed directly", () => {
    // Simulate a caller that skipped validation and handed a hostile id.
    const headers = voiceTraceHeaders("bad id\r\nInjected: 1", [
      { name: "admission", durationMs: 1 },
    ]);
    expect(headers.has(VOICE_TRACE_HEADER)).toBe(false);
    // Server-Timing is still present so timing observability is unaffected.
    expect(headers.get("Server-Timing")).toBe("admission;dur=1");
  });

  it("echoes a canonical id", () => {
    const headers = voiceTraceHeaders("voice-abc-123", [
      { name: "admission", durationMs: 1 },
    ]);
    expect(headers.get(VOICE_TRACE_HEADER)).toBe("voice-abc-123");
  });
});

describe("cloud voice trace headers", () => {
  it("reads and echoes X-Eliza-Voice-Trace-Id with Server-Timing", async () => {
    const request = new Request("https://api.test/api/v1/voice/stt", {
      headers: { [VOICE_TRACE_HEADER]: "trace-turn-1" },
    });
    const traceId = readVoiceTraceId(request);
    const response = voiceJsonResponse(
      { transcript: "ok" },
      {
        traceId,
        timings: [
          { name: "admission", durationMs: 3.4 },
          { name: "transcribe", durationMs: 12.6 },
          { name: "provider", durationMs: 12.6 },
        ],
      },
    );

    expect(response.headers.get(VOICE_TRACE_HEADER)).toBe("trace-turn-1");
    expect(response.headers.get("Server-Timing")).toBe(
      "admission;dur=3, transcribe;dur=13, provider;dur=13",
    );
    const payload = (await response.json()) as { transcript: string };
    expect(payload).toEqual({ transcript: "ok" });
  });

  it("keeps Server-Timing on untraced error responses", () => {
    const headers = voiceTraceHeaders(null, [
      { name: "admission", durationMs: 0 },
      { name: "error", durationMs: 1 },
    ]);

    expect(headers.has(VOICE_TRACE_HEADER)).toBe(false);
    expect(headers.get("Server-Timing")).toBe("admission;dur=0, error;dur=1");
  });
});

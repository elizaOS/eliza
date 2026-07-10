/**
 * Unit coverage for cloud voice trace response headers.
 *
 * The v1 STT and TTS routes call these helpers for every practical response
 * path, so the route-level contract for trace echo and Server-Timing presence
 * is locked here without mocking provider, auth, billing, or cache services.
 */

import { describe, expect, it } from "bun:test";

import {
  readVoiceTraceId,
  VOICE_TRACE_HEADER,
  voiceJsonResponse,
  voiceTraceHeaders,
} from "./trace";

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
    expect(await response.json()).toEqual({ transcript: "ok" });
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

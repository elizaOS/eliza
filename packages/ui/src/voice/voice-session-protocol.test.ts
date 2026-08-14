/** Validates the browser boundary for realtime voice control frames. */

import { describe, expect, it } from "vitest";
import { parseServerControl } from "./voice-session-protocol";

describe("voice session server protocol", () => {
  it("accepts and normalizes every required terminal turn_end outcome", () => {
    for (const outcome of [
      "spoken",
      "displayed",
      "no_response",
      "error",
      "stopped",
    ] as const) {
      expect(
        parseServerControl(
          JSON.stringify({ t: "turn_end", outcome, traceId: " trace-1 " }),
        ),
      ).toEqual({ t: "turn_end", outcome, traceId: "trace-1" });
    }
  });

  it.each([
    ["ready sessionId", { t: "ready", traceId: "trace-1" }],
    ["partial text", { t: "stt_partial", traceId: "trace-1" }],
    ["eager-EOT trace", { t: "stt_eager_eot" }],
    ["final text", { t: "stt_final", traceId: "trace-1" }],
    ["LLM trace", { t: "llm_first_text" }],
    ["speaking-start trace", { t: "speaking_start" }],
    ["speaking-end trace", { t: "speaking_end" }],
    ["turn outcome", { t: "turn_end", outcome: "maybe", traceId: "trace-1" }],
    [
      "interruption reason",
      { t: "interrupted", reason: "maybe", traceId: "trace-1" },
    ],
    ["error retryable flag", { t: "error", code: "failed" }],
    ["usage STT duration", { t: "usage", ttsChars: 0, traceId: "trace-1" }],
    ["usage TTS count", { t: "usage", sttMs: 0, traceId: "trace-1" }],
  ])("rejects a known frame with an invalid required %s", (_field, frame) => {
    expect(parseServerControl(JSON.stringify(frame))).toBeNull();
  });

  it("preserves empty final text while rejecting the missing-field shape", () => {
    expect(
      parseServerControl(
        JSON.stringify({ t: "stt_final", text: "", traceId: "trace-1" }),
      ),
    ).toEqual({ t: "stt_final", text: "", traceId: "trace-1" });
    expect(
      parseServerControl(
        JSON.stringify({ t: "stt_final", traceId: "trace-1" }),
      ),
    ).toBeNull();
  });

  it("accepts a bounded navigate-view handoff", () => {
    expect(
      parseServerControl(
        JSON.stringify({
          t: "navigate_view",
          viewId: " notes ",
          viewPath: " /notes ",
          subview: " recent ",
          traceId: " trace-1 ",
        }),
      ),
    ).toEqual({
      t: "navigate_view",
      viewId: "notes",
      viewPath: "/notes",
      subview: "recent",
      traceId: "trace-1",
    });
  });

  it("rejects navigate-view frames without a usable target or trace", () => {
    expect(
      parseServerControl(
        JSON.stringify({ t: "navigate_view", viewId: "", traceId: "trace-1" }),
      ),
    ).toBeNull();
    expect(
      parseServerControl(
        JSON.stringify({ t: "navigate_view", viewId: "notes", traceId: 7 }),
      ),
    ).toBeNull();
  });

  it("rejects an invalid optional subview rather than dropping it", () => {
    expect(
      parseServerControl(
        JSON.stringify({
          t: "navigate_view",
          viewId: "notes",
          subview: {},
          traceId: "trace-1",
        }),
      ),
    ).toBeNull();
  });

  it("rejects an invalid optional view path rather than falling back", () => {
    expect(
      parseServerControl(
        JSON.stringify({
          t: "navigate_view",
          viewId: "notes",
          viewPath: {},
          traceId: "trace-1",
        }),
      ),
    ).toBeNull();
  });

  it("rejects invalid optional fields rather than silently dropping them", () => {
    expect(
      parseServerControl(
        JSON.stringify({
          t: "error",
          code: "provider_failed",
          retryable: true,
          message: {},
        }),
      ),
    ).toBeNull();
    expect(
      parseServerControl(
        JSON.stringify({
          t: "usage",
          ttsChars: 1.5,
          traceId: "trace-1",
        }),
      ),
    ).toBeNull();
  });

  it("preserves bounded upstream error diagnostics", () => {
    expect(
      parseServerControl(
        JSON.stringify({
          t: "error",
          code: "upstream_error",
          retryable: false,
          upstreamStatus: 404,
          upstreamMessage: "Agent not found",
          upstreamSnippet: "Upstream request failed",
        }),
      ),
    ).toEqual({
      t: "error",
      code: "upstream_error",
      retryable: false,
      upstreamStatus: 404,
      upstreamMessage: "Agent not found",
      upstreamSnippet: "Upstream request failed",
    });
  });

  it.each([
    ["non-HTTP status", { upstreamStatus: 99 }],
    ["fractional status", { upstreamStatus: 503.5 }],
    ["non-string upstream message", { upstreamMessage: {} }],
    ["oversized upstream message", { upstreamMessage: "x".repeat(513) }],
    ["non-string upstream snippet", { upstreamSnippet: [] }],
    ["oversized upstream snippet", { upstreamSnippet: "x".repeat(513) }],
  ])("rejects an invalid %s", (_label, field) => {
    expect(
      parseServerControl(
        JSON.stringify({
          t: "error",
          code: "upstream_error",
          retryable: false,
          ...field,
        }),
      ),
    ).toBeNull();
  });
});

// @vitest-environment jsdom

// Unit tests for the shared-tier voice fallback (#15395). Covers:
//   (a) shared-base detection → v1 route selection (and dedicated → null)
//   (b) request/response adaptation (STT multipart body + { transcript } parse)
//   (c) the cheap mic-affordance guard (dedicated always available; shared
//       available only with a resolvable origin)

import { afterEach, describe, expect, it, vi } from "vitest";

// getElizaApiBase is a window-scoped accessor re-exported from @elizaos/shared.
// Mock the local re-export so we can drive the "active agent base" per-test.
vi.mock("../utils/eliza-globals", () => ({
  getElizaApiBase: vi.fn<() => string | undefined>(),
}));

vi.mock("../utils/cloud-agent-base", () => ({
  normalizeDirectCloudSharedAgentApiBase: (value: string) =>
    value.replace(/\/bridge\/?$/, ""),
}));

import { getElizaApiBase } from "../utils/eliza-globals";
import {
  buildSharedRuntimeSttBody,
  currentSharedRuntimeVoiceOrigin,
  isVoiceTargetResolvableForActiveAgent,
  markSharedRuntimeVoiceTrace,
  measureSharedRuntimeVoiceTrace,
  parseSharedRuntimeSttResponse,
  sharedRuntimeSttUrl,
  sharedRuntimeTtsUrl,
  sharedRuntimeVoiceMarkName,
  sharedRuntimeVoiceOrigin,
  sharedRuntimeVoiceTraceHeaders,
  VOICE_TRACE_HEADER,
} from "./shared-runtime-voice";

const getElizaApiBaseMock = vi.mocked(getElizaApiBase);

afterEach(() => {
  vi.clearAllMocks();
});

describe("sharedRuntimeVoiceOrigin (shared-base detection)", () => {
  it("derives the cloud-worker origin from a shared-runtime agent base", () => {
    expect(
      sharedRuntimeVoiceOrigin(
        "https://api.elizacloud.ai/api/v1/eliza/agents/cad3c071",
      ),
    ).toBe("https://api.elizacloud.ai");
  });

  it("handles the legacy /bridge suffix (normalized away) and trailing slash", () => {
    expect(
      sharedRuntimeVoiceOrigin(
        "https://api.elizacloud.ai/api/v1/eliza/agents/abc/bridge/",
      ),
    ).toBe("https://api.elizacloud.ai");
  });

  it("preserves a cloud-base path prefix that precedes the shared-agent tail", () => {
    expect(
      sharedRuntimeVoiceOrigin(
        "https://host.example/gw/api/v1/eliza/agents/xyz",
      ),
    ).toBe("https://host.example/gw");
  });

  it("returns null for a dedicated-subdomain base (no behavior change)", () => {
    expect(
      sharedRuntimeVoiceOrigin("https://cad3c071.elizacloud.ai"),
    ).toBeNull();
  });

  it("returns null for a raw bridge IP / non-shared base", () => {
    expect(sharedRuntimeVoiceOrigin("http://127.0.0.1:3000")).toBeNull();
    expect(
      sharedRuntimeVoiceOrigin("https://api.elizacloud.ai/api/v1/eliza/agents"),
    ).toBeNull();
  });

  it("returns null for blank / undefined input", () => {
    expect(sharedRuntimeVoiceOrigin(undefined)).toBeNull();
    expect(sharedRuntimeVoiceOrigin("")).toBeNull();
    expect(sharedRuntimeVoiceOrigin("   ")).toBeNull();
  });

  it("currentSharedRuntimeVoiceOrigin reads the active agent base", () => {
    getElizaApiBaseMock.mockReturnValue(
      "https://api.elizacloud.ai/api/v1/eliza/agents/abc",
    );
    expect(currentSharedRuntimeVoiceOrigin()).toBe("https://api.elizacloud.ai");

    getElizaApiBaseMock.mockReturnValue("https://abc.elizacloud.ai");
    expect(currentSharedRuntimeVoiceOrigin()).toBeNull();
  });
});

describe("v1 route URL builders", () => {
  it("builds the tts + stt URLs off the derived origin", () => {
    expect(sharedRuntimeTtsUrl("https://api.elizacloud.ai")).toBe(
      "https://api.elizacloud.ai/api/v1/voice/tts",
    );
    expect(sharedRuntimeSttUrl("https://api.elizacloud.ai/")).toBe(
      "https://api.elizacloud.ai/api/v1/voice/stt",
    );
  });
});

describe("shared-runtime voice trace headers", () => {
  it("adds X-Eliza-Voice-Trace-Id without changing stable base headers", () => {
    expect(
      sharedRuntimeVoiceTraceHeaders("trace-turn-1", {
        Accept: "audio/wav",
      }),
    ).toEqual({
      Accept: "audio/wav",
      [VOICE_TRACE_HEADER]: "trace-turn-1",
    });
  });

  it("leaves headers unchanged when no shared-runtime trace id exists", () => {
    expect(
      sharedRuntimeVoiceTraceHeaders(undefined, {
        Accept: "audio/wav",
      }),
    ).toEqual({ Accept: "audio/wav" });
  });
});

describe("STT request/response adaptation", () => {
  it("builds a multipart body with the WAV as an `audio` File (audio/wav)", () => {
    const wav = new Uint8Array([82, 73, 70, 70]); // "RIFF"
    const form = buildSharedRuntimeSttBody(wav);
    const file = form.get("audio");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("speech.wav");
    expect((file as File).type).toBe("audio/wav");
    expect((file as File).size).toBe(wav.byteLength);
  });

  it("parses the v1 `{ transcript }` response shape (trimmed)", () => {
    expect(parseSharedRuntimeSttResponse({ transcript: "  hi there " })).toBe(
      "hi there",
    );
  });

  it("tolerates a `{ text }` fallback shape", () => {
    expect(parseSharedRuntimeSttResponse({ text: " fallback " })).toBe(
      "fallback",
    );
  });

  it("returns '' for missing/blank/malformed bodies (caller enforces fail-loud)", () => {
    expect(parseSharedRuntimeSttResponse({ transcript: "   " })).toBe("");
    expect(parseSharedRuntimeSttResponse({})).toBe("");
    expect(parseSharedRuntimeSttResponse(null)).toBe("");
    expect(parseSharedRuntimeSttResponse("not-json")).toBe("");
    expect(parseSharedRuntimeSttResponse({ transcript: 42 })).toBe("");
  });
});

describe("isVoiceTargetResolvableForActiveAgent (mic-affordance guard)", () => {
  it("is true for a dedicated agent (defers to existing capture gate)", () => {
    getElizaApiBaseMock.mockReturnValue("https://abc.elizacloud.ai");
    expect(isVoiceTargetResolvableForActiveAgent()).toBe(true);
  });

  it("is true when no active base is set yet (never suppress the dedicated path)", () => {
    getElizaApiBaseMock.mockReturnValue(undefined);
    expect(isVoiceTargetResolvableForActiveAgent()).toBe(true);
  });

  it("is true for a shared agent with a resolvable https v1 origin", () => {
    getElizaApiBaseMock.mockReturnValue(
      "https://api.elizacloud.ai/api/v1/eliza/agents/abc",
    );
    expect(isVoiceTargetResolvableForActiveAgent()).toBe(true);
  });
});

describe("shared-runtime voice performance helpers", () => {
  it("uses stable mark names and stores traceId in detail", () => {
    const marks: Array<{ name: string; detail?: unknown }> = [];
    const measures: Array<{ name: string; detail?: unknown }> = [];
    const originalPerformance = globalThis.performance;
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: {
        mark: vi.fn((name: string, options?: PerformanceMarkOptions) => {
          marks.push({ name, detail: options?.detail });
        }),
        measure: vi.fn(
          (
            name: string,
            options?: PerformanceMeasureOptions | string,
            _end?: string,
          ) => {
            measures.push({
              name,
              detail:
                typeof options === "object" && options !== null
                  ? options.detail
                  : undefined,
            });
          },
        ),
      },
    });

    try {
      markSharedRuntimeVoiceTrace("stt_request_start", "trace-1");
      markSharedRuntimeVoiceTrace("stt_request_end", "trace-1");
      measureSharedRuntimeVoiceTrace(
        "stt_request_end",
        "stt_request_start",
        "stt_request_end",
        "trace-1",
      );
    } finally {
      Object.defineProperty(globalThis, "performance", {
        configurable: true,
        value: originalPerformance,
      });
    }

    expect(marks).toEqual([
      {
        name: sharedRuntimeVoiceMarkName("stt_request_start"),
        detail: { traceId: "trace-1" },
      },
      {
        name: sharedRuntimeVoiceMarkName("stt_request_end"),
        detail: { traceId: "trace-1" },
      },
    ]);
    expect(measures).toEqual([
      {
        name: sharedRuntimeVoiceMarkName("stt_request_end"),
        detail: { traceId: "trace-1" },
      },
    ]);
  });

  it("does not throw when performance APIs are absent or partial", () => {
    const originalPerformance = globalThis.performance;
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: {
        mark: vi.fn(() => {
          throw new Error("partial mark mock");
        }),
      },
    });

    try {
      expect(() =>
        markSharedRuntimeVoiceTrace("tts_request_start", "trace-1"),
      ).not.toThrow();
      expect(() =>
        measureSharedRuntimeVoiceTrace(
          "tts_end",
          "tts_request_start",
          "tts_end",
          "trace-1",
        ),
      ).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "performance", {
        configurable: true,
        value: originalPerformance,
      });
    }
  });
});

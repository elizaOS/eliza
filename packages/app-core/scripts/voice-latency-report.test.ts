import { describe, expect, it } from "vitest";
import {
  fetchAndRenderVoiceLatency,
  renderVoiceLatencyReport,
} from "./lib/voice-latency-report.mjs";

const SAMPLE_PAYLOAD = {
  generatedAtEpochMs: 1_700_000_000_000,
  checkpoints: ["vad-trigger", "llm-first-token", "tts-first-audio-chunk"],
  derivedKeys: ["ttftMs", "ttfaMs", "ttapMs"],
  openTurnCount: 1,
  traces: [
    {
      turnId: "vt-1",
      roomId: "roomA",
      t0EpochMs: 1_000_000,
      closedAtEpochMs: 1_001_300,
      checkpoints: [
        { name: "vad-trigger", tMs: 0, atEpochMs: 1_000_000 },
        { name: "llm-first-token", tMs: 150, atEpochMs: 1_000_150 },
      ],
      derived: { ttftMs: 150, ttfaMs: null, ttapMs: null },
      missing: ["tts-first-audio-chunk"],
      complete: false,
      anomalies: ['duplicate mark for "vad-trigger"'],
    },
    {
      turnId: "vt-2",
      roomId: null,
      t0EpochMs: 2_000_000,
      closedAtEpochMs: 2_001_400,
      checkpoints: [],
      derived: { ttftMs: 200, ttfaMs: 350, ttapMs: 380 },
      missing: [],
      complete: true,
      anomalies: [],
    },
  ],
  histograms: {
    ttftMs: {
      count: 2,
      p50: 200,
      p90: 200,
      p99: 200,
      min: 150,
      max: 200,
      mean: 175,
    },
    ttfaMs: {
      count: 1,
      p50: 350,
      p90: 350,
      p99: 350,
      min: 350,
      max: 350,
      mean: 350,
    },
    ttapMs: {
      count: 0,
      p50: null,
      p90: null,
      p99: null,
      min: null,
      max: null,
      mean: null,
    },
  },
};

describe("renderVoiceLatencyReport", () => {
  it("renders histograms and traces with — for null values", () => {
    const text = renderVoiceLatencyReport(SAMPLE_PAYLOAD);
    expect(text).toContain("2 trace(s)");
    expect(text).toContain("open turns: 1");
    expect(text).toContain("ttftMs");
    expect(text).toContain("150ms"); // p50 of ttftMs is 200, but ttapMs trace shows 380; min ttft is 150
    // The empty histogram prints — not 0 for percentiles.
    expect(text).toMatch(/ttapMs.*—/);
    // Incomplete trace flagged + missing list shown.
    expect(text).toContain("[incomplete]");
    expect(text).toContain("missing: tts-first-audio-chunk");
    expect(text).toContain("anomaly: duplicate mark");
    // Complete trace shows derived values.
    expect(text).toContain("ttap=380ms");
  });

  it("handles an empty payload gracefully", () => {
    const text = renderVoiceLatencyReport({
      generatedAtEpochMs: 0,
      checkpoints: [],
      derivedKeys: [],
      openTurnCount: 0,
      traces: [],
      histograms: {},
    });
    expect(text).toContain("No traces recorded yet.");
  });

  it("respects maxTraces", () => {
    const many = {
      ...SAMPLE_PAYLOAD,
      traces: Array.from({ length: 5 }, (_, i) => ({
        ...SAMPLE_PAYLOAD.traces[1],
        turnId: `vt-${i}`,
      })),
    };
    const text = renderVoiceLatencyReport(many, { maxTraces: 2 });
    expect(text).toContain("Recent traces (last 2)");
    expect(text).toContain("vt-3");
    expect(text).toContain("vt-4");
    expect(text).not.toContain("vt-0");
  });
});

describe("fetchAndRenderVoiceLatency", () => {
  it("renders the payload returned by the endpoint", async () => {
    const fakeFetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => SAMPLE_PAYLOAD,
      }) as unknown as Response;
    const result = await fetchAndRenderVoiceLatency("http://127.0.0.1:31337", {
      fetchImpl: fakeFetch,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.report).toContain("2 trace(s)");
  });

  it("surfaces a non-OK response without throwing", async () => {
    const fakeFetch = async () =>
      ({
        ok: false,
        status: 404,
        json: async () => ({}),
      }) as unknown as Response;
    const result = await fetchAndRenderVoiceLatency("http://127.0.0.1:31337", {
      fetchImpl: fakeFetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain("HTTP 404");
  });

  it("surfaces a fetch error without throwing", async () => {
    const fakeFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await fetchAndRenderVoiceLatency("http://127.0.0.1:31337", {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("appends ?limit= when given", async () => {
    let seenUrl = "";
    const fakeFetch = async (url: string) => {
      seenUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => SAMPLE_PAYLOAD,
      } as unknown as Response;
    };
    await fetchAndRenderVoiceLatency("http://127.0.0.1:31337", {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      limit: 7,
    });
    expect(seenUrl).toContain("limit=7");
    expect(seenUrl).toContain("/api/dev/voice-latency");
  });
});

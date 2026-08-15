/** Exercises voice latency report behavior with deterministic app-core test fixtures. */
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fetchAndRenderVoiceLatency,
  renderVoiceLatencyReport,
} from "./lib/voice-latency-report.mjs";
import { parsePositiveLimit } from "./lib/voice-latency-report-limit.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./voice-latency-report.mjs", import.meta.url),
);
const INVALID_LIMIT_CASES = [
  { label: "missing", raw: undefined, args: [] },
  { label: "empty", raw: "", args: [""] },
  { label: "zero", raw: "0", args: ["0"] },
  { label: "negative", raw: "-3", args: ["-3"] },
  { label: "fractional", raw: "1.5", args: ["1.5"] },
  { label: "partial", raw: "10junk", args: ["10junk"] },
  { label: "NaN", raw: "NaN", args: ["NaN"] },
  { label: "infinite", raw: "Infinity", args: ["Infinity"] },
  { label: "signed", raw: "+1", args: ["+1"] },
  { label: "next flag", raw: "--json", args: ["--json"] },
  { label: "out of range", raw: "2147483648", args: ["2147483648"] },
];
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

function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [SCRIPT_PATH, ...args],
      {
        encoding: "utf8",
        env: { ...process.env, ELIZA_API_PORT: "1" },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `voice-latency-report failed: ${error.message}\n${stdout}${stderr}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

describe("renderVoiceLatencyReport", () => {
  it("renders histograms and traces with — for null values", () => {
    const text = renderVoiceLatencyReport(SAMPLE_PAYLOAD);
    expect(text).toContain("2 trace(s)");
    expect(text).toContain("open turns: 1");
    expect(text).toContain("ttftMs");
    expect(text).toContain("150ms"); // p50 of ttftMs is 200, but ttapMs trace shows 380; min ttft is 150
    // The empty histogram prints — not 0 for percentiles.
    expect(text).toMatch(/ttapMs.*—/);
    // Incomplete/partial trace flagged + missing list shown.
    expect(text).toMatch(/\[(?:incomplete|partial)\]/);
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

describe("voice-latency-report --limit validation", () => {
  it("accepts complete positive integers", () => {
    expect(parsePositiveLimit("1")).toBe(1);
    expect(parsePositiveLimit("7")).toBe(7);
    expect(parsePositiveLimit("2147483647")).toBe(2147483647);
  });

  it.each(INVALID_LIMIT_CASES)("rejects invalid --limit: $label", ({ raw }) => {
    expect(() => parsePositiveLimit(raw)).toThrow(/--limit/);
  });

  it.each(INVALID_LIMIT_CASES)(
    "real CLI rejects $label before fetching",
    ({ args }) => {
      const result = spawnSync(
        process.execPath,
        [SCRIPT_PATH, "--limit", ...args],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", ELIZA_API_PORT: "1" },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/--limit/);
      expect(result.stdout + result.stderr).not.toMatch(
        /could not fetch|ECONNREFUSED/i,
      );
    },
  );

  it("real CLI sends a valid limit to the endpoint", async () => {
    let seenUrl = "";
    const server = createServer((req, res) => {
      seenUrl = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(SAMPLE_PAYLOAD));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("voice latency test server did not expose a TCP port");
      }
      const result = await runCli([
        "--limit",
        "7",
        "--base",
        `http://127.0.0.1:${address.port}`,
      ]);

      expect(seenUrl).toBe("/api/dev/voice-latency?limit=7");
      expect(result.stdout).toContain("2 trace(s)");
      expect(result.stderr).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

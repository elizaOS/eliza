/**
 * Executor-seam unit coverage: drives the real `runAnalyzerInline`,
 * `InlineExecutor`, and the shared `INLINE_EXECUTOR` with hand-written
 * analyzers (the seam callers implement). Proves the honest contract — tier
 * gating short-circuits before `analyze`, wall-clock timing, skip fragments
 * pass through with a reason and no fabricated data, and any throw becomes a
 * bounded `failed` record instead of escaping.
 */
import { describe, expect, it } from "vitest";
import {
  INLINE_EXECUTOR,
  InlineExecutor,
  runAnalyzerInline,
} from "./executor.ts";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerFragment,
  AnalyzerInput,
  AnalyzerResult,
} from "./types.ts";

const inputFor = (
  absolutePath = "/tmp/subject.png",
  path = "visual/x/after.png",
): AnalyzerInput => ({
  entry: {
    path,
    sha256: "0".repeat(64),
    bytes: 0,
    kind: "screenshot",
    source: "test",
    producedBy: "test",
    createdAt: new Date().toISOString(),
  },
  absolutePath,
});

const ctxAt = (tier: AnalyzerContext["tier"]): AnalyzerContext => ({ tier });

/** An analyzer that records each invocation so gating can be observed. */
const analyzerOf = (
  tier: Analyzer["tier"],
  analyze: Analyzer["analyze"],
  calls: string[] = [],
): Analyzer => ({
  name: "test.analyzer",
  tier,
  kinds: ["screenshot"],
  analyze(input, ctx) {
    calls.push(input.absolutePath);
    return analyze(input, ctx);
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runAnalyzerInline tier gating", () => {
  it("records skipped-tier at durationMs 0 without calling analyze", async () => {
    const calls: string[] = [];
    const gpu = analyzerOf(
      "gpu",
      () => ({ status: "ran", data: { ok: true } }) as AnalyzerFragment,
      calls,
    );
    const result = await runAnalyzerInline(gpu, inputFor(), ctxAt("cpu"));
    expect(result.status).toBe("skipped-tier");
    expect(result.reason).toBe("analyzer tier 'gpu' above run tier 'cpu'");
    expect(result.durationMs).toBe(0);
    expect(result).not.toHaveProperty("data");
    expect(calls).toEqual([]);
  });

  it("gates a full-tier analyzer at both cpu and gpu run tiers", async () => {
    for (const runTier of ["cpu", "gpu"] as const) {
      const full = analyzerOf("full", () => ({
        status: "ran",
        data: null,
      }));
      const result = await runAnalyzerInline(full, inputFor(), ctxAt(runTier));
      expect(result.status).toBe("skipped-tier");
      expect(result.reason).toBe(
        `analyzer tier 'full' above run tier '${runTier}'`,
      );
    }
  });

  it("runs a gpu-tier analyzer when the run tier allows it", async () => {
    for (const runTier of ["gpu", "full"] as const) {
      const gpu = analyzerOf("gpu", () => ({ status: "ran", data: 42 }));
      const result = await runAnalyzerInline(gpu, inputFor(), ctxAt(runTier));
      expect(result.status).toBe("ran");
      expect(result.data).toBe(42);
    }
  });

  it("runs a cpu-tier analyzer at every run tier", async () => {
    for (const runTier of ["cpu", "gpu", "full"] as const) {
      const cpu = analyzerOf("cpu", () => ({ status: "ran", data: true }));
      const result = await runAnalyzerInline(cpu, inputFor(), ctxAt(runTier));
      expect(result.status).toBe("ran");
      expect(result.data).toBe(true);
    }
  });
});

describe("runAnalyzerInline success path", () => {
  it("returns ran with the fragment's data and no reason key", async () => {
    const data = { changed_fraction: 0.25 };
    const analyzer = analyzerOf("cpu", () => ({ status: "ran", data }));
    const result = await runAnalyzerInline(analyzer, inputFor(), ctxAt("cpu"));
    expect(result.status).toBe("ran");
    expect(result.data).toStrictEqual(data);
    expect(result).not.toHaveProperty("reason");
    expect(Number.isInteger(result.durationMs)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("accepts a synchronously returned fragment, not just a promise", async () => {
    const analyzer = analyzerOf("cpu", () => ({ status: "ran", data: [1, 2] }));
    const result = await runAnalyzerInline(analyzer, inputFor(), ctxAt("cpu"));
    expect(result.status).toBe("ran");
    expect(result.data).toEqual([1, 2]);
  });

  it("times the analyze call in wall-clock milliseconds", async () => {
    const analyzer = analyzerOf("cpu", async () => {
      await sleep(50);
      return { status: "ran", data: null } as AnalyzerFragment;
    });
    const result = await runAnalyzerInline(analyzer, inputFor(), ctxAt("cpu"));
    expect(result.status).toBe("ran");
    expect(result.durationMs).toBeGreaterThanOrEqual(45);
  });

  it("passes an explicit skip through with its reason and no data", async () => {
    const analyzer = analyzerOf("cpu", () => ({
      status: "skipped-missing-tool",
      reason: "tesseract not installed",
    }));
    const result: AnalyzerResult = await runAnalyzerInline(
      analyzer,
      inputFor(),
      ctxAt("cpu"),
    );
    expect(result.status).toBe("skipped-missing-tool");
    expect(result.reason).toBe("tesseract not installed");
    expect(result).not.toHaveProperty("data");
  });
});

describe("runAnalyzerInline failure boundary", () => {
  it("translates a thrown Error into a failed record carrying its message", async () => {
    const analyzer = analyzerOf("cpu", () => {
      throw new Error("analysis bug");
    });
    const result = await runAnalyzerInline(analyzer, inputFor(), ctxAt("cpu"));
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("analysis bug");
    expect(Number.isInteger(result.durationMs)).toBe(true);
  });

  it("truncates a long failure message to 300 characters", async () => {
    const long = "x".repeat(500);
    const analyzer = analyzerOf("cpu", () => {
      throw new Error(long);
    });
    const result = await runAnalyzerInline(analyzer, inputFor(), ctxAt("cpu"));
    expect(result.status).toBe("failed");
    expect(result.reason).toBe(long.slice(0, 300));
    expect(result.reason).toHaveLength(300);
  });

  it("stringifies a non-Error rejection verbatim", async () => {
    const analyzer = analyzerOf("cpu", () => Promise.reject("boom"));
    const result = await runAnalyzerInline(analyzer, inputFor(), ctxAt("cpu"));
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("boom");
  });

  it("still measures duration on the failed path", async () => {
    const analyzer = analyzerOf("cpu", async () => {
      await sleep(30);
      throw new Error("late failure");
    });
    const result = await runAnalyzerInline(analyzer, inputFor(), ctxAt("cpu"));
    expect(result.status).toBe("failed");
    expect(result.durationMs).toBeGreaterThanOrEqual(25);
  });
});

describe("InlineExecutor and the shared instance", () => {
  it("exposes INLINE_EXECUTOR as a reusable InlineExecutor", () => {
    expect(INLINE_EXECUTOR).toBeInstanceOf(InlineExecutor);
  });

  it("produces the same ran record as the canonical function", async () => {
    const viaExecutor = INLINE_EXECUTOR.execute(
      analyzerOf("cpu", () => ({ status: "ran", data: { n: 7 } })),
      inputFor(),
      ctxAt("cpu"),
    );
    const viaFunction = runAnalyzerInline(
      analyzerOf("cpu", () => ({ status: "ran", data: { n: 7 } })),
      inputFor(),
      ctxAt("cpu"),
    );
    expect(await viaExecutor).toMatchObject({
      status: "ran",
      data: { n: 7 },
    });
    expect(await viaFunction).toMatchObject({
      status: "ran",
      data: { n: 7 },
    });
  });

  it("keeps the failed boundary identical through the class", async () => {
    const executor = new InlineExecutor();
    const throwing = analyzerOf("cpu", () => {
      throw new Error("class path failure");
    });
    const result = await executor.execute(throwing, inputFor(), ctxAt("full"));
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("class path failure");
  });
});

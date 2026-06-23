/**
 * CI/lane coverage for the TS LifeOps prompt benchmark harness (#8795).
 *
 * The catalog-shape test is hermetic and runs in normal PR CI. The benchmark
 * execution test is live-gated because it boots a real LifeOps runtime with an
 * LLM provider and can spend model budget.
 */
import { describe, expect, it } from "vitest";
import {
  buildLifeOpsPromptBenchmarkCases,
  PROMPT_BENCHMARK_VARIANT_IDS,
} from "./helpers/lifeops-prompt-benchmark-cases.js";
import {
  buildAxOptimizationRows,
  formatPromptBenchmarkReportMarkdown,
  runLifeOpsPromptBenchmark,
  serializeAxOptimizationRows,
} from "./helpers/lifeops-prompt-benchmark-runner.js";

const LIVE =
  process.env.LIFEOPS_PROMPT_BENCHMARK_LIVE === "1" ||
  process.env.TEST_LANE === "post-merge";

function liveCaseLimit(): number {
  const parsed = Number(process.env.LIFEOPS_PROMPT_BENCHMARK_CASE_LIMIT ?? 15);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 15;
}

describe("LifeOps prompt benchmark catalog", () => {
  it("loads benchmark cases across suites and variants", async () => {
    const cases = await buildLifeOpsPromptBenchmarkCases();
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((testCase) => testCase.suiteId))).toEqual(
      new Set(["lifeops-self-care", "lifeops-executive-assistant"]),
    );
    for (const variantId of PROMPT_BENCHMARK_VARIANT_IDS) {
      expect(cases.some((testCase) => testCase.variantId === variantId)).toBe(
        true,
      );
    }
  });
});

describe.skipIf(!LIVE)("LifeOps prompt benchmark live gate", () => {
  it(
    "drives runLifeOpsPromptBenchmark and emits optimization rows",
    async () => {
      const allCases = await buildLifeOpsPromptBenchmarkCases();
      const directCases = allCases.filter(
        (testCase) => testCase.variantId === "direct",
      );
      const cases = directCases.slice(0, liveCaseLimit());
      expect(cases.length).toBeGreaterThan(0);

      const report = await runLifeOpsPromptBenchmark({
        cases,
        isolate: "shared",
      });
      expect(report.total).toBe(cases.length);
      expect(report.accuracy).toBeGreaterThanOrEqual(
        Number(process.env.LIFEOPS_PROMPT_BENCHMARK_MIN_ACCURACY ?? 0),
      );

      const markdown = formatPromptBenchmarkReportMarkdown(report);
      const axRows = buildAxOptimizationRows(report);
      const serializedAxRows = serializeAxOptimizationRows(axRows);

      expect(markdown).toContain("# LifeOps Prompt Benchmark");
      expect(axRows).toHaveLength(report.total);
      expect(serializedAxRows.trim().split("\n")).toHaveLength(report.total);
    },
    300_000,
  );
});

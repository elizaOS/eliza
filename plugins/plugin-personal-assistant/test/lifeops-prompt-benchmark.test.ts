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
  LIFEOPS_PROMPT_BENCHMARK_TASKS,
  PROMPT_BENCHMARK_VARIANT_IDS,
  type PromptBenchmarkCase,
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

function selectDirectCasesCoveringAllTasks(
  cases: PromptBenchmarkCase[],
  requestedLimit: number,
): PromptBenchmarkCase[] {
  const selected: PromptBenchmarkCase[] = [];
  const seen = new Set<string>();
  for (const task of LIFEOPS_PROMPT_BENCHMARK_TASKS) {
    const match = cases.find((testCase) => testCase.optimizationTask === task);
    if (!match) {
      throw new Error(`Missing direct benchmark case for task ${task}`);
    }
    selected.push(match);
    seen.add(match.caseId);
  }

  const limit = Math.max(LIFEOPS_PROMPT_BENCHMARK_TASKS.length, requestedLimit);
  for (const testCase of cases) {
    if (selected.length >= limit) break;
    if (seen.has(testCase.caseId)) continue;
    selected.push(testCase);
    seen.add(testCase.caseId);
  }
  return selected;
}

describe("LifeOps prompt benchmark catalog", () => {
  it("loads benchmark cases across suites and variants", async () => {
    const cases = await buildLifeOpsPromptBenchmarkCases();
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((testCase) => testCase.suiteId))).toEqual(
      new Set([
        "lifeops-self-care",
        "lifeops-executive-assistant",
        "lifeops-capability-coverage",
      ]),
    );
    expect(new Set(cases.map((testCase) => testCase.optimizationTask))).toEqual(
      new Set(LIFEOPS_PROMPT_BENCHMARK_TASKS),
    );
    for (const variantId of PROMPT_BENCHMARK_VARIANT_IDS) {
      expect(cases.some((testCase) => testCase.variantId === variantId)).toBe(
        true,
      );
    }
    expect(
      cases.some(
        (testCase) =>
          testCase.variantId === "direct" &&
          testCase.expectedAction === "OWNER_REMINDERS" &&
          testCase.prompt.includes("registration by the 20th"),
      ),
    ).toBe(true);
  });
});

describe.skipIf(!LIVE)("LifeOps prompt benchmark live gate", () => {
  it("drives runLifeOpsPromptBenchmark and emits optimization rows", async () => {
    const allCases = await buildLifeOpsPromptBenchmarkCases();
    const directCases = allCases.filter(
      (testCase) => testCase.variantId === "direct",
    );
    const cases = selectDirectCasesCoveringAllTasks(
      directCases,
      liveCaseLimit(),
    );
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((testCase) => testCase.optimizationTask))).toEqual(
      new Set(LIFEOPS_PROMPT_BENCHMARK_TASKS),
    );

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
  }, 300_000);
});

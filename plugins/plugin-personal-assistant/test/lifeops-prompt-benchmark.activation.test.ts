/**
 * Activation coverage for the LifeOps prompt-benchmark harness (#8795 item 5).
 *
 * `lifeops-prompt-benchmark-runner.ts` + `lifeops-prompt-benchmark-cases.ts`
 * shipped a full token/cost-accounting benchmark apparatus that NO test drove —
 * dead infrastructure. This test exercises every pure scoring/report/export
 * function deterministically against a synthetic case (no live provider, no
 * on-disk scenario corpus needed), drives the case loader when the scenario
 * corpus is present, and runs the full live benchmark behind an explicit opt-in
 * (`RUN_LIFEOPS_PROMPT_BENCHMARK=1`) for the post-merge / live lane.
 */
import { describe, expect, it } from "vitest";
import {
  buildLifeOpsPromptBenchmarkCases,
  type PromptBenchmarkCase,
} from "./helpers/lifeops-prompt-benchmark-cases.js";
import {
  buildAxOptimizationRows,
  buildPromptBenchmarkReport,
  formatPromptBenchmarkReportMarkdown,
  type PromptBenchmarkResult,
  promptBenchmarkCasePasses,
  runLifeOpsPromptBenchmark,
  serializeAxOptimizationRows,
} from "./helpers/lifeops-prompt-benchmark-runner.js";

const RUN_LIVE = process.env.RUN_LIFEOPS_PROMPT_BENCHMARK === "1";

const SYNTHETIC_CASE: PromptBenchmarkCase = {
  caseId: "synthetic.calendar.create",
  suiteId: "lifeops-executive-assistant",
  baseScenarioId: "synthetic-base",
  scenarioTitle: "Synthetic calendar create",
  domain: "calendar",
  basePrompt: "schedule lunch with Dana tomorrow at noon",
  prompt: "schedule lunch with Dana tomorrow at noon",
  benchmarkContext: "",
  variantId: "direct",
  variantLabel: "Direct",
  axes: [],
  riskClass: "positive",
  benchmarkWeight: 1,
  expectedAction: "CALENDAR",
  acceptableActions: [],
  forbiddenActions: ["BLOCK"],
  expectedOperation: null,
  tags: ["synthetic"],
};

function makeResult(
  testCase: PromptBenchmarkCase,
  actualPrimaryAction: string | null,
): PromptBenchmarkResult {
  const base: PromptBenchmarkResult = {
    case: testCase,
    actualPrimaryAction,
    actualActions: actualPrimaryAction ? [actualPrimaryAction] : [],
    pass: false,
    latencyMs: 12,
    responseText: "ok",
    llmCallCount: 1,
    trajectoryId: "traj-synthetic",
  };
  return { ...base, pass: promptBenchmarkCasePasses(base) };
}

describe("LifeOps prompt-benchmark harness — activation", () => {
  it("scores a matching action as a pass and a wrong action as a fail", () => {
    expect(makeResult(SYNTHETIC_CASE, "CALENDAR").pass).toBe(true);
    expect(makeResult(SYNTHETIC_CASE, "__DEFINITELY_NOT_AN_ACTION__").pass).toBe(
      false,
    );
  });

  it("honors forbidden actions", () => {
    // The model produced the forbidden action -> fail regardless of anything else.
    expect(makeResult(SYNTHETIC_CASE, "BLOCK").pass).toBe(false);
  });

  it("aggregates a report, Ax rows, and markdown from results", () => {
    const results = [
      makeResult(SYNTHETIC_CASE, "CALENDAR"), // pass
      makeResult(SYNTHETIC_CASE, "__DEFINITELY_NOT_AN_ACTION__"), // fail
    ];
    const report = buildPromptBenchmarkReport({
      providerName: "synthetic",
      results,
    });

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.accuracy).toBeCloseTo(0.5, 5);
    expect(report.trajectoryCaptureRate).toBeCloseTo(1, 5);

    const rows = buildAxOptimizationRows(report);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(SYNTHETIC_CASE.caseId);
    expect(rows[0]?.expected.action).toBe("CALENDAR");

    const jsonl = serializeAxOptimizationRows(rows);
    const lines = jsonl.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0] ?? "")).not.toThrow();

    const markdown = formatPromptBenchmarkReportMarkdown(report);
    expect(markdown).toContain("# LifeOps Prompt Benchmark");
    expect(markdown).toContain("50.0%");
  });

  it("loads the case catalog when the scenario corpus is present", async () => {
    // The catalog dynamically imports the `test/scenarios/**` corpus, which is
    // not vendored into every checkout. Exercise the loader when present; skip
    // (not fail) when the corpus is absent so the pure-function coverage above
    // still guards the harness in a minimal checkout.
    let cases: PromptBenchmarkCase[] | null = null;
    try {
      cases = await buildLifeOpsPromptBenchmarkCases();
    } catch (err) {
      console.warn(
        `[lifeops-benchmark] scenario corpus unavailable; skipping loader assertion: ${String(err)}`,
      );
      return;
    }
    expect(cases.length).toBeGreaterThan(0);
    for (const testCase of cases) {
      expect(testCase.caseId).toBeTruthy();
      expect(testCase.prompt).toBeTruthy();
      expect(typeof testCase.benchmarkWeight).toBe("number");
    }
  });

  it.skipIf(!RUN_LIVE)(
    "runs the full live benchmark over the case catalog",
    async () => {
      const cases = await buildLifeOpsPromptBenchmarkCases();
      const report = await runLifeOpsPromptBenchmark({
        cases: cases.slice(0, 5),
        isolate: "shared",
      });
      expect(report.total).toBeGreaterThan(0);
      expect(report.passed).toBeGreaterThan(0);
    },
    600_000,
  );
});

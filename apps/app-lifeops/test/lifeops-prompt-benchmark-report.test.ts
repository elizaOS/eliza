import { describe, expect, it } from "vitest";
import type { PromptBenchmarkResult } from "./helpers/lifeops-prompt-benchmark-runner.ts";
import {
  buildAxOptimizationRows,
  buildPromptBenchmarkReport,
  formatPromptBenchmarkReportMarkdown,
  serializeAxOptimizationRows,
} from "./helpers/lifeops-prompt-benchmark-runner.ts";

const SAMPLE_RESULTS: PromptBenchmarkResult[] = [
  {
    case: {
      caseId: "workout-blocker-basic__direct",
      suiteId: "lifeops-self-care",
      baseScenarioId: "workout-blocker-basic",
      scenarioTitle: "Workout blocker routine",
      domain: "habits",
      basePrompt:
        "Set up a workout habit every afternoon. Block X, Instagram, and Hacker News until I finish it, then unlock them for 60 minutes.",
      prompt:
        "Set up a workout habit every afternoon. Block X, Instagram, and Hacker News until I finish it, then unlock them for 60 minutes.",
      variantId: "direct",
      variantLabel: "Direct",
      axes: ["baseline", "direct"],
      riskClass: "positive",
      benchmarkWeight: 1,
      expectedAction: "LIFE",
      acceptableActions: [],
      forbiddenActions: [],
      expectedOperation: "create_definition",
      tags: ["lifeops-self-care", "habits", "direct", "positive"],
    },
    actualPrimaryAction: "LIFE",
    actualActions: ["LIFE"],
    latencyMs: 1200,
    llmCallCount: 2,
    pass: true,
    plannerPrompt: "User: set up a workout habit...",
    plannerResponse: "LIFE action selected",
    responseText: "I can set up that workout routine.",
    trajectoryId: "traj-1",
  },
  {
    case: {
      caseId: "ea.schedule.daily-time-with-jill__subtle-null",
      suiteId: "lifeops-executive-assistant",
      baseScenarioId: "ea.schedule.daily-time-with-jill",
      scenarioTitle: "Reserve recurring daily time with Jill",
      domain: "executive-assistant",
      basePrompt:
        "Need to book 1 hour per day for time with Jill. Any time is fine, ideally before sleep.",
      prompt:
        "Do not do this yet. I'm only thinking out loud: need to book 1 hour per day for time with Jill. Any time is fine, ideally before sleep.",
      variantId: "subtle-null",
      variantLabel: "Subtle Null",
      axes: ["null-case", "non-request", "confuser"],
      riskClass: "null",
      benchmarkWeight: 2,
      expectedAction: null,
      acceptableActions: ["REPLY"],
      forbiddenActions: ["CALENDAR_ACTION", "PROPOSE_MEETING_TIMES"],
      expectedOperation: null,
      tags: [
        "lifeops-executive-assistant",
        "executive-assistant",
        "subtle-null",
        "null",
      ],
    },
    actualPrimaryAction: "CALENDAR_ACTION",
    actualActions: ["REPLY", "CALENDAR_ACTION"],
    latencyMs: 1500,
    llmCallCount: 1,
    pass: false,
    plannerPrompt: "User: thinking out loud about Jill",
    plannerResponse: "CALENDAR_ACTION",
    responseText: "I'll go ahead and schedule it.",
    trajectoryId: "traj-2",
  },
];

describe("LifeOps prompt benchmark reporting", () => {
  it("computes weighted accuracy, null false positives, and trajectory coverage", () => {
    const report = buildPromptBenchmarkReport({
      providerName: "groq",
      results: SAMPLE_RESULTS,
    });

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.accuracy).toBe(0.5);
    expect(report.weightedAccuracy).toBeCloseTo(1 / 3, 5);
    expect(report.falsePositiveRate).toBe(1);
    expect(report.trajectoryCaptureRate).toBe(1);
    expect(report.bySuite["lifeops-self-care"]?.accuracy).toBe(1);
    expect(report.byRiskClass.null?.accuracy).toBe(0);
  });

  it("exports Ax-friendly JSONL rows with prompt, expectation, and observed trace fields", () => {
    const report = buildPromptBenchmarkReport({
      providerName: "groq",
      results: SAMPLE_RESULTS,
    });
    const rows = buildAxOptimizationRows(report);
    const serialized = serializeAxOptimizationRows(rows);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: "workout-blocker-basic__direct",
        expected: expect.objectContaining({
          action: "LIFE",
          operation: "create_definition",
        }),
        observed: expect.objectContaining({
          action: "LIFE",
          trajectoryId: "traj-1",
        }),
      }),
    );
    expect(() => JSON.parse(serialized.trim().split("\n")[0] ?? "")).not.toThrow();
  });

  it("formats a markdown summary that includes accuracy and failure slices", () => {
    const report = buildPromptBenchmarkReport({
      providerName: "groq",
      results: SAMPLE_RESULTS,
    });
    const markdown = formatPromptBenchmarkReportMarkdown(report);

    expect(markdown).toContain("# LifeOps Prompt Benchmark");
    expect(markdown).toContain("weighted");
    expect(markdown).toContain("Null-case false positive rate");
    expect(markdown).toContain("ea.schedule.daily-time-with-jill__subtle-null");
  });
});

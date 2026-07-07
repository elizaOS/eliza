/**
 * Optimization-report tests exercise the deterministic artifact builder and
 * temp-filesystem writer without invoking a live optimizer or model.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOptimizationRunReport,
  buildPromptDiff,
  writeOptimizationRunReport,
} from "./optimization-report.js";
import type { TrainingRunRecord } from "./training-orchestrator.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "optimization-report-"));
  tempDirs.push(dir);
  return dir;
}

function makeRun(
  overrides: Partial<TrainingRunRecord> = {},
): TrainingRunRecord {
  return {
    runId: "run-report-1",
    status: "succeeded",
    task: "response",
    backend: "native",
    source: "manual",
    datasetSize: 3,
    startedAt: "2026-07-06T10:00:00.000Z",
    finishedAt: "2026-07-06T10:01:00.000Z",
    pulledTrajectories: 3,
    filteredTrajectories: 3,
    redactionCount: 0,
    anonymizationCount: 0,
    dryRun: false,
    ...overrides,
  };
}

describe("optimization reports", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
    delete process.env.TRAINING_STATE_DIR;
  });

  it("builds a prompt diff from the changed middle lines", () => {
    const diff = buildPromptDiff("a\nremove\nz", "a\nadd\nz");

    expect(diff.changed).toBe(true);
    expect(diff.removedLines).toEqual(["remove"]);
    expect(diff.addedLines).toEqual(["add"]);
  });

  it("renders promoted artifacts with lineage, frontier, and gate trace", () => {
    const report = buildOptimizationRunReport({
      run: makeRun({ artifactPath: "/tmp/v2.json" }),
      generatedAt: "2026-07-06T10:02:00.000Z",
      artifact: {
        baseline: "task\nold rule",
        prompt: "task\nnew rule",
        score: 0.8,
        baselineScore: 0.5,
        lineage: [{ round: 0, variant: 0, score: 0.5, notes: "baseline" }],
        frontier: [
          {
            prompt: "task\nnew rule",
            score: 0.8,
            promptTokenCount: 4,
            origin: "feedback-mut",
          },
        ],
        promotionDecision: {
          promote: true,
          delta: 0.3,
          incumbentScores: [0.5, 0.5, 0.5],
        },
      },
    });

    expect(report.headline).toMatchObject({
      verdict: "promoted",
      scoreDelta: 0.3,
    });
    expect(report.promptDiff?.removedLines).toEqual(["old rule"]);
    expect(report.promptDiff?.addedLines).toEqual(["new rule"]);
    expect(report.lineage).toHaveLength(1);
    expect(report.frontier[0]).toMatchObject({
      origin: "feedback-mut",
      promoted: true,
    });
    expect(report.promotionGate).toMatchObject({ promote: true });
  });

  it("writes JSON and HTML reports next to the run record", async () => {
    const root = await makeTempDir();
    process.env.TRAINING_STATE_DIR = root;
    const artifactPath = join(root, "artifact.json");
    await writeFile(
      artifactPath,
      `${JSON.stringify({
        baseline: "baseline prompt",
        prompt: "optimized prompt",
        score: 0.9,
        baselineScore: 0.7,
        lineage: [{ round: 0, variant: 0, score: 0.7 }],
        frontier: [
          {
            prompt: "optimized prompt",
            score: 0.9,
            promptTokenCount: 2,
            origin: "seed-feedback",
          },
        ],
        promotionDecision: { promote: true, delta: 0.2 },
      })}\n`,
      "utf-8",
    );

    const result = await writeOptimizationRunReport(
      makeRun({ artifactPath, runId: "run-write-1" }),
    );
    const json = JSON.parse(await readFile(result.reportJsonPath, "utf-8")) as {
      schema: string;
      headline: { verdict: string };
    };
    const html = await readFile(result.reportHtmlPath, "utf-8");

    expect(json.schema).toBe("eliza_optimization_run_report");
    expect(json.headline.verdict).toBe("promoted");
    expect(html).toContain("Quality vs Tokens Frontier");
    expect(html).toContain("optimized prompt");
  });

  it("turns rejected-candidate notes into a gate report", () => {
    const report = buildOptimizationRunReport({
      run: makeRun({
        artifactPath: undefined,
        notes: [
          "/other note",
          "rejected candidate written to /tmp/rejected.json",
        ],
      }),
      rejectedArtifact: {
        incumbentPrompt: "old",
        candidatePrompt: "new",
        reason: "candidate did not improve",
        scores: {
          incumbentMeanScore: 0.8,
          incumbentStdDev: 0,
          candidateScore: 0.2,
          delta: -0.6,
          promotionMargin: 0,
          noiseThreshold: 1.5,
          incumbentReseeds: 3,
          examplesPerPass: 2,
          incumbentScores: [0.8, 0.8, 0.8],
        },
      },
    });

    expect(report.headline.verdict).toBe("rejected");
    expect(report.run.rejectedCandidatePath).toBe("/tmp/rejected.json");
    expect(report.promotionGate).toMatchObject({
      promote: false,
      delta: -0.6,
    });
  });
});

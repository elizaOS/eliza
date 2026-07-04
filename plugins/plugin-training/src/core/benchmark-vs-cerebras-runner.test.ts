/**
 * Covers the Eliza-1-vs-Cerebras runner's tier list and subprocess-arg
 * assembly — pure, no subprocess is spawned.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  benchmarkVsCerebrasTierList,
  buildBenchmarkVsCerebrasArgs,
} from "./benchmark-vs-cerebras-runner.js";

describe("benchmark_vs_cerebras runner", () => {
  it("defaults benchmark tiers to the full Eliza-1 harness sweep", () => {
    const trainingRoot = "/repo/packages/training";
    const args = buildBenchmarkVsCerebrasArgs(
      {},
      {
        trainingRoot,
        outputDir: "/tmp/run",
      },
    );

    expect(args.slice(0, 7)).toEqual([
      join(trainingRoot, "scripts", "benchmark_vs_cerebras.py"),
      "--tiers",
      "gemma4-e2b,gemma4-e4b,gemma4-12b,gemma4-31b",
      "--benchmark",
      "eliza_harness_action_selection",
      "--variants",
      "trained",
    ]);
  });

  it("builds the smallest-tier Eliza harness command with ResultsStore and matrix outputs", () => {
    const trainingRoot = "/repo/packages/training";
    const args = buildBenchmarkVsCerebrasArgs(
      {
        tiers: "2b",
        benchmark: "eliza_harness_action_selection",
        variants: "both",
        maxSamples: 12,
        resultsDb: "/tmp/results.db",
        trainedModelPath: "/tmp/checkpoints/eliza-1-2b/final",
        datasetVersion: "eliza-native-v1",
        codeCommit: "deadbeef",
        dryRun: true,
      },
      {
        trainingRoot,
        outputDir: "/tmp/run",
        matrixOutputDir: "/tmp/matrix",
      },
    );

    expect(args).toEqual([
      join(trainingRoot, "scripts", "benchmark_vs_cerebras.py"),
      "--tiers",
      "gemma4-e2b",
      "--benchmark",
      "eliza_harness_action_selection",
      "--variants",
      "both",
      "--cerebras-model",
      "gemma-4-31b",
      "--max-samples",
      "12",
      "--output-dir",
      "/tmp/run",
      "--trained-model-path",
      "/tmp/checkpoints/eliza-1-2b/final",
      "--dry-run",
      "--results-db",
      "/tmp/results.db",
      "--dataset-version",
      "eliza-native-v1",
      "--code-commit",
      "deadbeef",
      "--matrix-output-dir",
      "/tmp/matrix",
    ]);
  });

  it("maps Eliza tier aliases to training registry keys", () => {
    expect(benchmarkVsCerebrasTierList("2b,4b,9b,27b")).toBe(
      "gemma4-e2b,gemma4-e4b,gemma4-12b,gemma4-31b",
    );
    expect(benchmarkVsCerebrasTierList("all")).toBe("all");
    expect(benchmarkVsCerebrasTierList("google/gemma-4-E2B")).toBe(
      "gemma4-e2b",
    );
  });

  it("rejects retired Qwen tier aliases instead of remapping them", () => {
    expect(() => benchmarkVsCerebrasTierList("qwen3.5-2b")).toThrow(
      /Qwen tier aliases are retired/,
    );
  });
});

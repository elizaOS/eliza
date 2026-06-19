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
      "qwen3.5-0.8b,qwen3.5-2b,qwen3.5-4b,qwen3.5-9b,qwen3.6-27b",
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
        tiers: "qwen3.5-0.8b",
        benchmark: "eliza_harness_action_selection",
        variants: "both",
        maxSamples: 12,
        resultsDb: "/tmp/results.db",
        trainedModelPath: "/tmp/checkpoints/eliza-1-0_8b/final",
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
      "qwen3.5-0.8b",
      "--benchmark",
      "eliza_harness_action_selection",
      "--variants",
      "both",
      "--cerebras-model",
      "gpt-oss-120b",
      "--max-samples",
      "12",
      "--output-dir",
      "/tmp/run",
      "--trained-model-path",
      "/tmp/checkpoints/eliza-1-0_8b/final",
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
    expect(benchmarkVsCerebrasTierList("0_8b,2b,4b,9b,27b")).toBe(
      "qwen3.5-0.8b,qwen3.5-2b,qwen3.5-4b,qwen3.5-9b,qwen3.6-27b",
    );
    expect(benchmarkVsCerebrasTierList("all")).toBe("all");
    expect(benchmarkVsCerebrasTierList("qwen3.5-0.8b")).toBe("qwen3.5-0.8b");
  });
});

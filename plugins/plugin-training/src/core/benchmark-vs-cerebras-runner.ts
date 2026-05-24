import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ELIZA_ONE_BENCHMARK_TIER_LIST } from "./eliza1-benchmark-recipe.js";
import { trainingStateRoot } from "./training-config.js";

export type BenchmarkVsCerebrasBenchmark =
  | "eliza_harness_action_selection"
  | "clawbench"
  | "hermes"
  | "all";

export interface BenchmarkVsCerebrasRunOptions {
  trainingRoot?: string;
  python?: string;
  tiers?: string;
  benchmark?: BenchmarkVsCerebrasBenchmark;
  variants?: "trained" | "base" | "both";
  cerebrasModel?: string;
  maxSamples?: number;
  outputDir?: string;
  checkpointsDir?: string;
  trainedModelPath?: string;
  dryRun?: boolean;
  resultsDb?: string;
  datasetVersion?: string;
  codeCommit?: string;
  matrixOutputDir?: string;
}

export interface BenchmarkVsCerebrasRunResult {
  trainingRoot: string;
  outputDir: string;
  matrixOutputDir: string | null;
  matrixArtifactPath: string | null;
  resultsDb: string | null;
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

const TRAINING_TIER_KEYS: Record<string, string> = {
  "0_8b": "qwen3.5-0.8b",
  "0.8b": "qwen3.5-0.8b",
  "0-8b": "qwen3.5-0.8b",
  "2b": "qwen3.5-2b",
  "4b": "qwen3.5-4b",
  "9b": "qwen3.5-9b",
  "27b": "qwen3.6-27b",
};

function normalizeTrainingTierKey(value: string): string {
  const trimmed = value.trim();
  const key = trimmed.toLowerCase();
  return TRAINING_TIER_KEYS[key] ?? trimmed;
}

export function benchmarkVsCerebrasTierList(value: string | undefined): string {
  const raw = value?.trim() || ELIZA_ONE_BENCHMARK_TIER_LIST;
  if (raw.toLowerCase() === "all") return "all";
  return raw
    .split(",")
    .map(normalizeTrainingTierKey)
    .filter(Boolean)
    .join(",");
}

function collectProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

export function buildBenchmarkVsCerebrasArgs(
  options: BenchmarkVsCerebrasRunOptions,
  resolved: {
    trainingRoot: string;
    outputDir: string;
    matrixOutputDir?: string;
  },
): string[] {
  const scriptPath = join(
    resolved.trainingRoot,
    "scripts",
    "benchmark_vs_cerebras.py",
  );
  const args = [
    scriptPath,
    "--tiers",
    benchmarkVsCerebrasTierList(options.tiers),
    "--benchmark",
    options.benchmark ?? "eliza_harness_action_selection",
    "--variants",
    options.variants ?? "trained",
    "--cerebras-model",
    options.cerebrasModel ?? "gpt-oss-120b",
    "--max-samples",
    String(
      typeof options.maxSamples === "number"
        ? Math.max(1, Math.floor(options.maxSamples))
        : 50,
    ),
    "--output-dir",
    resolved.outputDir,
  ];
  if (options.checkpointsDir)
    args.push("--checkpoints-dir", options.checkpointsDir);
  if (options.trainedModelPath)
    args.push("--trained-model-path", options.trainedModelPath);
  if (options.dryRun) args.push("--dry-run");
  if (options.resultsDb) args.push("--results-db", options.resultsDb);
  if (options.datasetVersion)
    args.push("--dataset-version", options.datasetVersion);
  if (options.codeCommit) args.push("--code-commit", options.codeCommit);
  if (resolved.matrixOutputDir) {
    args.push("--matrix-output-dir", resolved.matrixOutputDir);
  }
  return args;
}

export async function runBenchmarkVsCerebras(
  options: BenchmarkVsCerebrasRunOptions,
): Promise<BenchmarkVsCerebrasRunResult> {
  const trainingRoot = resolve(
    options.trainingRoot ?? join(process.cwd(), "packages", "training"),
  );
  const stamp = safeTimestamp(new Date().toISOString());
  const outputDir =
    options.outputDir ?? join(trainingStateRoot(), "benchmarks", "runs", stamp);
  const matrixOutputDir =
    options.matrixOutputDir ??
    join(trainingStateRoot(), "benchmarks", "matrices", stamp);
  await mkdir(outputDir, { recursive: true });
  await mkdir(matrixOutputDir, { recursive: true });
  const args = buildBenchmarkVsCerebrasArgs(options, {
    trainingRoot,
    outputDir,
    matrixOutputDir,
  });
  const proc = await collectProcess(
    options.python ?? "python3",
    args,
    trainingRoot,
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `benchmark_vs_cerebras.py exited with code ${proc.exitCode}: ${proc.stderr || proc.stdout}`,
    );
  }
  return {
    trainingRoot,
    outputDir,
    matrixOutputDir,
    matrixArtifactPath: join(matrixOutputDir, "benchmark-matrix.json"),
    resultsDb: options.resultsDb ?? null,
    command: [options.python ?? "python3", ...args],
    stdout: proc.stdout,
    stderr: proc.stderr,
    exitCode: proc.exitCode,
  };
}

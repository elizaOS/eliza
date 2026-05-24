import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { trainingStateRoot } from "./training-config.js";

export const EVAL_COMPARISON_ARTIFACT_SCHEMA = "eliza_eval_comparison_artifact";
export const EVAL_COMPARISON_ARTIFACT_VERSION = 1;

export interface EvalComparisonArtifactInput {
  report: Record<string, unknown>;
  reportPath?: string;
  outputDir?: string;
  source?: Record<string, unknown>;
}

export interface EvalComparisonRunOptions {
  trainingRoot?: string;
  python?: string;
  manifestPath?: string;
  model?: string;
  trainedModelPath?: string;
  backend?: "mlx" | "cuda" | "cpu";
  promptFile?: string;
  maxTokens?: number;
  systemPrompt?: string;
  outputPath?: string;
  outputDir?: string;
  dryRun?: boolean;
}

export interface EvalComparisonArtifact {
  schema: typeof EVAL_COMPARISON_ARTIFACT_SCHEMA;
  version: typeof EVAL_COMPARISON_ARTIFACT_VERSION;
  generatedAt: string;
  reportPath?: string;
  source: Record<string, unknown>;
  models: {
    base: string | null;
    trained: string | null;
    backend: string | null;
  };
  metrics: {
    baseScore: number | null;
    trainedScore: number | null;
    improvementAbsolute: number | null;
    improvementPercent: number | null;
    baseLatencyMs: number | null;
    trainedLatencyMs: number | null;
    latencyDeltaMs: number | null;
    promptCount: number | null;
    distinctResponseCount: number | null;
  };
  summaries: {
    base: Record<string, unknown> | null;
    trained: Record<string, unknown> | null;
    comparison: Record<string, unknown> | null;
  };
  raw: Record<string, unknown>;
}

export interface EvalComparisonArtifactResult {
  outputDir: string;
  artifactPath: string;
  artifact: EvalComparisonArtifact;
}

export interface EvalComparisonRunResult extends EvalComparisonArtifactResult {
  trainingRoot: string;
  command: string[];
  reportPath: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function buildLocalEvalComparisonArgs(
  options: EvalComparisonRunOptions,
  resolved: { trainingRoot: string; reportPath: string },
): string[] {
  const scriptPath = join(
    resolved.trainingRoot,
    "scripts",
    "rl",
    "compare_local_models.py",
  );
  const args = [scriptPath];
  if (options.manifestPath) {
    args.push("--manifest", options.manifestPath);
  } else {
    if (!options.model || !options.trainedModelPath || !options.backend) {
      throw new Error(
        "Provide either manifestPath or model, trainedModelPath, and backend",
      );
    }
    args.push("--model", options.model);
    args.push("--trained-model-path", options.trainedModelPath);
    args.push("--backend", options.backend);
  }
  if (options.promptFile) args.push("--prompt-file", options.promptFile);
  if (typeof options.maxTokens === "number") {
    args.push(
      "--max-tokens",
      String(Math.max(1, Math.floor(options.maxTokens))),
    );
  }
  if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
  args.push("--output", resolved.reportPath);
  return args;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstNumber(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstString(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function nestedSummary(
  report: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const variant = asRecord(report[key]);
  return asRecord(variant?.summary);
}

function extractVariantModel(
  report: Record<string, unknown>,
  key: string,
): string | null {
  const variant = asRecord(report[key]);
  return firstString(variant, [
    "model_name",
    "model_ref",
    "adapter_path",
    "served_model_id",
  ]);
}

function roundMetric(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(4));
}

function improvementPercent(base: number | null, trained: number | null) {
  if (base === null || trained === null || base === 0) return null;
  return ((trained - base) / Math.abs(base)) * 100;
}

export function buildEvalComparisonArtifactPayload(
  input: EvalComparisonArtifactInput,
): EvalComparisonArtifact {
  const report = input.report;
  const baseSummary =
    nestedSummary(report, "base_model") ?? asRecord(report.base_summary);
  const trainedSummary =
    nestedSummary(report, "trained_model") ??
    nestedSummary(report, "adapter_model") ??
    asRecord(report.trained_summary) ??
    asRecord(report.adapter_summary);
  const comparison = asRecord(report.comparison);
  const baseScore = firstNumber(baseSummary, [
    "avg_score",
    "score",
    "format_ok",
    "content_ok",
    "test_avg_score",
  ]);
  const trainedScore = firstNumber(trainedSummary, [
    "avg_score",
    "score",
    "format_ok",
    "content_ok",
    "test_avg_score",
  ]);
  const baseLatencyMs = firstNumber(baseSummary, [
    "avg_latency_ms",
    "latency_ms",
  ]);
  const trainedLatencyMs = firstNumber(trainedSummary, [
    "avg_latency_ms",
    "latency_ms",
  ]);
  const promptCount =
    firstNumber(baseSummary, ["prompt_count", "test_sample_count"]) ??
    firstNumber(trainedSummary, ["prompt_count", "test_sample_count"]);
  const generatedAt =
    asString(report.timestamp) ??
    asString(report.generated_at) ??
    asString(report.evaluated_at) ??
    new Date().toISOString();

  return {
    schema: EVAL_COMPARISON_ARTIFACT_SCHEMA,
    version: EVAL_COMPARISON_ARTIFACT_VERSION,
    generatedAt,
    reportPath: input.reportPath,
    source: input.source ?? { kind: "training_eval_comparison" },
    models: {
      base:
        extractVariantModel(report, "base_model") ??
        firstString(report, ["base_model", "model", "base_model_id"]),
      trained:
        extractVariantModel(report, "trained_model") ??
        extractVariantModel(report, "adapter_model") ??
        firstString(report, [
          "trained_model",
          "adapter_model",
          "trained_model_id",
        ]),
      backend: asString(report.backend),
    },
    metrics: {
      baseScore: roundMetric(baseScore),
      trainedScore: roundMetric(trainedScore),
      improvementAbsolute: roundMetric(
        baseScore !== null && trainedScore !== null
          ? trainedScore - baseScore
          : null,
      ),
      improvementPercent: roundMetric(
        improvementPercent(baseScore, trainedScore),
      ),
      baseLatencyMs: roundMetric(baseLatencyMs),
      trainedLatencyMs: roundMetric(trainedLatencyMs),
      latencyDeltaMs: roundMetric(
        baseLatencyMs !== null && trainedLatencyMs !== null
          ? trainedLatencyMs - baseLatencyMs
          : null,
      ),
      promptCount: promptCount === null ? null : Math.round(promptCount),
      distinctResponseCount:
        firstNumber(comparison, ["distinct_response_count"]) ?? null,
    },
    summaries: {
      base: baseSummary,
      trained: trainedSummary,
      comparison,
    },
    raw: report,
  };
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

export async function writeEvalComparisonArtifact(
  input: EvalComparisonArtifactInput,
): Promise<EvalComparisonArtifactResult> {
  const artifact = buildEvalComparisonArtifactPayload(input);
  const outputDir =
    input.outputDir ??
    join(trainingStateRoot(), "evals", safeTimestamp(artifact.generatedAt));
  await mkdir(outputDir, { recursive: true });
  const artifactPath = join(outputDir, "eval-comparison.json");
  await writeFile(
    artifactPath,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf-8",
  );
  return { outputDir, artifactPath, artifact };
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

export async function runLocalEvalComparison(
  options: EvalComparisonRunOptions,
): Promise<EvalComparisonRunResult> {
  const trainingRoot = resolve(
    options.trainingRoot ?? join(process.cwd(), "packages", "training"),
  );
  const outputDir =
    options.outputDir ??
    join(trainingStateRoot(), "evals", safeTimestamp(new Date().toISOString()));
  await mkdir(outputDir, { recursive: true });
  const reportPath = resolve(
    options.outputPath ?? join(outputDir, "local_model_comparison.json"),
  );
  const command = options.python ?? "python3";
  const args = buildLocalEvalComparisonArgs(options, {
    trainingRoot,
    reportPath,
  });
  if (options.dryRun) {
    const artifactResult = await writeEvalComparisonArtifact({
      report: {
        timestamp: new Date().toISOString(),
        backend: options.backend,
        base_model: {
          model_ref: options.model ?? options.manifestPath ?? null,
          summary: {},
        },
        trained_model: {
          model_ref: options.trainedModelPath ?? options.manifestPath ?? null,
          summary: {},
        },
        comparison: {
          dry_run: true,
        },
      },
      reportPath,
      outputDir,
      source: {
        kind: "training_local_eval_comparison",
        trainingRoot,
        manifestPath: options.manifestPath,
        model: options.model,
        trainedModelPath: options.trainedModelPath,
        backend: options.backend,
        dryRun: true,
      },
    });
    return {
      ...artifactResult,
      trainingRoot,
      command: [command, ...args],
      reportPath,
      stdout: "[DRY RUN] Would run local eval comparison.",
      stderr: "",
      exitCode: 0,
    };
  }

  const proc = await collectProcess(command, args, trainingRoot);
  if (proc.exitCode !== 0) {
    throw new Error(
      `compare_local_models.py exited with code ${proc.exitCode}: ${proc.stderr || proc.stdout}`,
    );
  }
  const report = JSON.parse(await readFile(reportPath, "utf-8")) as Record<
    string,
    unknown
  >;
  const artifactResult = await writeEvalComparisonArtifact({
    report,
    reportPath,
    outputDir,
    source: {
      kind: "training_local_eval_comparison",
      trainingRoot,
      manifestPath: options.manifestPath,
      model: options.model,
      trainedModelPath: options.trainedModelPath,
      backend: options.backend,
    },
  });
  return {
    ...artifactResult,
    trainingRoot,
    command: [command, ...args],
    reportPath,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exitCode: proc.exitCode,
  };
}

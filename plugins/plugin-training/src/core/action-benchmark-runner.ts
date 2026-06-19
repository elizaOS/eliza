import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { trainingStateRoot } from "./training-config.js";
import { defaultBunCommand, resolveWorkspaceRoot } from "./workspace-runtime.js";

export type ActionBenchmarkMatrixVariant = "reference" | "base" | "trained";

export interface ActionBenchmarkRunOptions {
  workspaceRoot?: string;
  bun?: string;
  outputDir?: string;
  useMocks?: boolean;
  forceTrajectoryCapture?: boolean;
  filter?: string;
  runsPerCase?: number;
  provider?: string;
  modelId?: string;
  runtimeModel?: string;
  smallModel?: string;
  largeModel?: string;
  baseUrl?: string;
  variant?: ActionBenchmarkMatrixVariant;
  tier?: string;
  benchmark?: string;
  datasetVersion?: string;
  codeCommit?: string;
  dryRun?: boolean;
}

export interface ActionBenchmarkRunResult {
  workspaceRoot: string;
  appCoreRoot: string;
  outputDir: string;
  reportMarkdownPath: string;
  reportJsonPath: string;
  trajectoryDir: string;
  command: string[];
  env: Record<string, string>;
  stdout: string;
  stderr: string;
  exitCode: number;
  matrixSource: {
    path: string;
    modelId?: string;
    benchmark?: string;
    variant?: ActionBenchmarkMatrixVariant;
    tier?: string;
    provider?: string;
    datasetVersion?: string;
    codeCommit?: string;
    useMocks?: boolean;
  } | null;
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function positiveInt(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : undefined;
}

function collectProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
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

function stringSetting(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function modelListUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return `${normalized}/models`;
}

function localModelIdMatches(availableId: string, requestedId: string): boolean {
  return (
    availableId === requestedId ||
    availableId === `${requestedId}:latest` ||
    `${availableId}:latest` === requestedId
  );
}

async function localModelIds(baseUrl: string): Promise<string[]> {
  const response = await fetch(modelListUrl(baseUrl));
  if (!response.ok) {
    throw new Error(
      `local model endpoint ${modelListUrl(baseUrl)} returned ${response.status} ${response.statusText}`,
    );
  }
  const payload = await response.json();
  const data =
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  return data
    .map((item) =>
      item && typeof item === "object"
        ? (item as { id?: unknown; name?: unknown }).id ??
          (item as { id?: unknown; name?: unknown }).name
        : item,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export async function assertLocalBenchmarkModelAvailable(
  options: ActionBenchmarkRunOptions,
): Promise<void> {
  if (effectiveUseMocks(options)) return;
  if (options.provider !== "local-llama-cpp") return;
  const requestedModel = stringSetting(options.runtimeModel);
  if (!requestedModel) return;
  const baseUrl = stringSetting(options.baseUrl) ?? "http://localhost:11434/v1";
  const ids = await localModelIds(baseUrl);
  if (ids.some((id) => localModelIdMatches(id, requestedModel))) return;
  throw new Error(
    `local action benchmark model "${requestedModel}" is not available at ${modelListUrl(
      baseUrl,
    )}; available models: ${ids.length > 0 ? ids.join(", ") : "none"}`,
  );
}

function effectiveUseMocks(options: ActionBenchmarkRunOptions): boolean {
  return options.useMocks ?? options.dryRun === true;
}

function matrixSourceForReport(
  reportJsonPath: string,
  options: ActionBenchmarkRunOptions,
): ActionBenchmarkRunResult["matrixSource"] {
  const modelId =
    stringSetting(options.modelId) ?? stringSetting(options.provider);
  const variant = options.variant;
  if (!modelId || !variant) return null;
  return {
    path: reportJsonPath,
    modelId,
    variant,
    benchmark: stringSetting(options.benchmark),
    tier: stringSetting(options.tier),
    provider: stringSetting(options.provider),
    datasetVersion: stringSetting(options.datasetVersion),
    codeCommit: stringSetting(options.codeCommit),
    useMocks: effectiveUseMocks(options),
  };
}

function dryRunCaseSample(options: ActionBenchmarkRunOptions, trajectoryDir: string) {
  const tier = stringSetting(options.tier) ?? "0_8b";
  const variant = stringSetting(options.variant) ?? "trained";
  const modelId = stringSetting(options.modelId) ?? stringSetting(options.runtimeModel);
  return {
    caseId: `dry-run-${tier}-${variant}-action-selection`,
    prompt: "Can you check my calendar?",
    expectedAction: "CHECK_RUNTIME",
    actualAction: null,
    pass: false,
    response: "Dry-run benchmark provenance sample; no model inference executed.",
    latencyMs: 0,
    trajectoryPath: join(
      trajectoryDir,
      `dry-run-${tier}-${variant}-action-selection.json`,
    ),
    dryRun: true,
    modelId,
    tier,
    variant,
  };
}

async function annotateBenchmarkReportSource(
  reportJsonPath: string,
  options: ActionBenchmarkRunOptions,
): Promise<void> {
  const matrixSource = matrixSourceForReport(reportJsonPath, options);
  if (!matrixSource) return;
  const parsed = JSON.parse(await readFile(reportJsonPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const report = parsed as Record<string, unknown>;
  const existingSource =
    report.source &&
    typeof report.source === "object" &&
    !Array.isArray(report.source)
      ? (report.source as Record<string, unknown>)
      : {};
  report.source = {
    ...existingSource,
    modelId: matrixSource.modelId,
    variant: matrixSource.variant,
    benchmark: matrixSource.benchmark,
    tier: matrixSource.tier,
    provider: matrixSource.provider,
    datasetVersion: matrixSource.datasetVersion,
    codeCommit: matrixSource.codeCommit,
    useMocks: matrixSource.useMocks,
  };
  await writeFile(
    reportJsonPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

export function buildActionBenchmarkCommand(): string[] {
  return [
    "x",
    "vitest",
    "run",
    "--config",
    "../test/vitest/real.config.ts",
    "test/benchmarks/action-selection.real.test.ts",
    "--exclude",
    ".git/**",
    "--exclude",
    ".eliza/**",
  ];
}

export function buildActionBenchmarkEnv(
  options: ActionBenchmarkRunOptions,
  resolved: {
    reportMarkdownPath: string;
    reportJsonPath: string;
    trajectoryDir: string;
  },
): Record<string, string> {
  const env: Record<string, string> = {
    ELIZA_RUN_ACTION_BENCHMARK: "1",
    ELIZA_ACTION_BENCHMARK_REPORT_PATH: resolved.reportMarkdownPath,
    ELIZA_ACTION_BENCHMARK_REPORT_JSON_PATH: resolved.reportJsonPath,
    ELIZA_ACTION_BENCHMARK_TRAJECTORY_DIR: resolved.trajectoryDir,
  };
  if (effectiveUseMocks(options)) env.ELIZA_BENCHMARK_USE_MOCKS = "1";
  if (options.forceTrajectoryCapture !== false) {
    env.ELIZA_DUMP_TRAJECTORIES = "1";
    env.ELIZA_TRAJECTORY_MARKDOWN = "1";
  }
  const runsPerCase = positiveInt(options.runsPerCase);
  if (runsPerCase) env.ELIZA_BENCHMARK_RUNS_PER_CASE = String(runsPerCase);
  if (options.filter?.trim())
    env.ELIZA_BENCHMARK_FILTER = options.filter.trim();
  if (options.provider?.trim()) {
    const provider = options.provider.trim();
    env.ELIZA_BENCHMARK_PROVIDER = provider;
    if (provider === "local-llama-cpp") {
      env.LOCAL_LLAMA_CPP_API_KEY =
        process.env.LOCAL_LLAMA_CPP_API_KEY ?? "local";
    }
  }
  const runtimeModel = stringSetting(options.runtimeModel);
  const smallModel = stringSetting(options.smallModel) ?? runtimeModel;
  const largeModel = stringSetting(options.largeModel) ?? runtimeModel;
  if (smallModel) env.ELIZA_LIVE_TEST_SMALL_MODEL = smallModel;
  if (largeModel) env.ELIZA_LIVE_TEST_LARGE_MODEL = largeModel;
  if (options.baseUrl?.trim()) {
    env.ELIZA_LIVE_TEST_LOCAL_LLAMA_CPP_BASE_URL = options.baseUrl.trim();
  }
  return env;
}

export async function runActionBenchmark(
  options: ActionBenchmarkRunOptions = {},
): Promise<ActionBenchmarkRunResult> {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const appCoreRoot = join(workspaceRoot, "packages", "app-core");
  const stamp = safeTimestamp(new Date().toISOString());
  const outputDir =
    options.outputDir ??
    join(trainingStateRoot(), "benchmarks", "action-selection", stamp);
  const reportMarkdownPath = join(outputDir, "action-benchmark-report.md");
  const reportJsonPath = join(outputDir, "action-benchmark-report.json");
  const trajectoryDir = join(outputDir, "trajectories");
  await mkdir(outputDir, { recursive: true });
  await mkdir(trajectoryDir, { recursive: true });

  const command = options.bun ?? defaultBunCommand();
  const args = buildActionBenchmarkCommand();
  const benchmarkEnv = buildActionBenchmarkEnv(options, {
    reportMarkdownPath,
    reportJsonPath,
    trajectoryDir,
  });
  const reportMatrixSource = matrixSourceForReport(reportJsonPath, options);
  if (options.dryRun) {
    const sample = dryRunCaseSample(options, trajectoryDir);
    await writeFile(
      String(sample.trajectoryPath),
      `${JSON.stringify(
        {
          schema: "eliza_action_benchmark_dry_run_trajectory",
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          source: {
            kind: "app_core_action_selection_benchmark",
            dryRun: true,
            modelId: sample.modelId,
            tier: sample.tier,
            variant: sample.variant,
          },
          caseId: sample.caseId,
          prompt: sample.prompt,
          expectedAction: sample.expectedAction,
          actualAction: sample.actualAction,
          pass: sample.pass,
          response: sample.response,
          events: [
            {
              type: "DRY_RUN_BENCHMARK_CASE",
              timestamp: new Date().toISOString(),
              data: {
                reason: "No model inference executed in dry-run mode.",
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      reportJsonPath,
      `${JSON.stringify(
        {
          schema: "eliza_action_selection_benchmark_report",
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          source: {
            kind: "app_core_action_selection_benchmark",
            trajectoryDir,
            reportMarkdownPath,
            modelId: reportMatrixSource?.modelId,
            variant: reportMatrixSource?.variant,
            benchmark: reportMatrixSource?.benchmark,
            tier: reportMatrixSource?.tier,
            provider: reportMatrixSource?.provider,
            datasetVersion: reportMatrixSource?.datasetVersion,
            codeCommit: reportMatrixSource?.codeCommit,
            useMocks: reportMatrixSource?.useMocks,
            dryRun: true,
          },
          summary: {
            total: 1,
            passed: 0,
            failed: 1,
            accuracy: 0,
            plannerAccuracy: 0,
            executionAccuracy: 0,
          },
          failureModes: {
            dry_run: 1,
          },
          failures: [
            {
              caseId: sample.caseId,
              failureMode: "dry_run",
              reason: "No model inference executed in dry-run mode.",
            },
          ],
          results: [sample],
          dryRun: true,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      reportMarkdownPath,
      "# Action Selection Benchmark Dry Run\n\nNo benchmark cases were executed.\n",
      "utf8",
    );
    return {
      workspaceRoot,
      appCoreRoot,
      outputDir,
      reportMarkdownPath,
      reportJsonPath,
      trajectoryDir,
      command: [command, ...args],
      env: benchmarkEnv,
      stdout: "[DRY RUN] Would run app-core action selection benchmark.",
      stderr: "",
      exitCode: 0,
      matrixSource: reportMatrixSource,
    };
  }

  await assertLocalBenchmarkModelAvailable(options);

  const proc = await collectProcess(command, args, appCoreRoot, {
    ...process.env,
    ...benchmarkEnv,
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `action selection benchmark exited with code ${proc.exitCode}: ${
        proc.stderr || proc.stdout
      }`,
    );
  }
  await annotateBenchmarkReportSource(reportJsonPath, options);
  return {
    workspaceRoot,
    appCoreRoot,
    outputDir,
    reportMarkdownPath,
    reportJsonPath,
    trajectoryDir,
    command: [command, ...args],
    env: benchmarkEnv,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exitCode: proc.exitCode,
    matrixSource: matrixSourceForReport(reportJsonPath, options),
  };
}

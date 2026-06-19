import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { trainingStateRoot } from "./training-config.js";
import { defaultBunCommand, resolveWorkspaceRoot } from "./workspace-runtime.js";

export interface ScenarioRunOptions {
  workspaceRoot?: string;
  bun?: string;
  scenarioDir?: string;
  outputDir?: string;
  runId?: string;
  scenario?: string;
  fileGlobs?: string[];
  exportNative?: boolean;
  useDeterministicProxy?: boolean;
  dryRun?: boolean;
}

export interface ScenarioRunResult {
  workspaceRoot: string;
  scenarioRunnerRoot: string;
  scenarioDir: string;
  outputDir: string;
  runId: string;
  matrixPath: string;
  viewerHtmlPath: string;
  nativeJsonlPath: string | null;
  nativeManifestPath: string | null;
  command: string[];
  env: Record<string, string>;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function countJsonlRows(path: string): Promise<number> {
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

async function writeScenarioNativeManifest(input: {
  outputDir: string;
  runId: string;
  scenario: string | undefined;
  nativeJsonlPath: string | null;
  dryRun: boolean;
}): Promise<string | null> {
  if (!input.nativeJsonlPath) return null;
  const manifestPath = join(input.outputDir, "scenario-native.manifest.json");
  const rows = await countJsonlRows(input.nativeJsonlPath);
  const manifest = {
    schema: "eliza_scenario_native_export",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      kind: "scenario_native_export",
      runId: input.runId,
      scenario: input.scenario?.trim() || null,
      dryRun: input.dryRun,
    },
    outputDir: input.outputDir,
    runDir: input.outputDir,
    jsonlPath: input.nativeJsonlPath,
    manifestPath,
    runIds: [input.runId],
    scenarioIds: input.scenario?.trim() ? [input.scenario.trim()] : [],
    counts: {
      rows,
      jsonlRows: rows,
      parsedTrajectories: rows,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
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

export function buildScenarioRunCommand(
  options: ScenarioRunOptions,
  resolved: {
    scenarioDir: string;
    outputDir: string;
    runId: string;
    nativeJsonlPath: string | null;
  },
): string[] {
  const args = [
    "src/cli.ts",
    "run",
    resolved.scenarioDir,
    "--run-dir",
    resolved.outputDir,
    "--runId",
    resolved.runId,
  ];
  if (resolved.nativeJsonlPath) {
    args.push("--export-native", resolved.nativeJsonlPath);
  }
  if (options.scenario?.trim()) {
    args.push("--scenario", options.scenario.trim());
  }
  for (const glob of options.fileGlobs ?? []) {
    if (glob.trim()) args.push(glob.trim());
  }
  return args;
}

export async function runScenarios(
  options: ScenarioRunOptions = {},
): Promise<ScenarioRunResult> {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const scenarioRunnerRoot = join(workspaceRoot, "packages", "scenario-runner");
  const stamp = safeTimestamp(new Date().toISOString());
  const runId = options.runId?.trim() || `training-scenarios-${stamp}`;
  const outputDir =
    options.outputDir ??
    join(trainingStateRoot(), "scenarios", safeSegment(runId));
  const scenarioDir = resolve(
    options.scenarioDir ?? join(scenarioRunnerRoot, "test", "scenarios"),
  );
  const nativeJsonlPath =
    options.exportNative === false
      ? null
      : join(outputDir, "scenario-native.jsonl");
  const nativeManifestPath = nativeJsonlPath
    ? join(outputDir, "scenario-native.manifest.json")
    : null;
  const matrixPath = join(outputDir, "matrix.json");
  const viewerHtmlPath = join(outputDir, "viewer", "index.html");
  await mkdir(outputDir, { recursive: true });
  const command = options.bun ?? defaultBunCommand();
  const args = buildScenarioRunCommand(options, {
    scenarioDir,
    outputDir,
    runId,
    nativeJsonlPath,
  });
  const env: Record<string, string> = {};
  if (options.useDeterministicProxy !== false) {
    env.SCENARIO_USE_LLM_PROXY = "1";
  }
  if (options.dryRun) {
    await mkdir(join(outputDir, "viewer"), { recursive: true });
    if (nativeJsonlPath) await writeFile(nativeJsonlPath, "", "utf8");
    await writeFile(
      matrixPath,
      `${JSON.stringify(
        {
          schema: "eliza_scenario_run_viewer_v1",
          generatedAt: new Date().toISOString(),
          runId,
          runDir: outputDir,
          providerName:
            options.useDeterministicProxy === false
              ? "configured-provider"
              : "deterministic-proxy",
          scenarios: [
            {
              id: options.scenario?.trim() || "dry-run",
              status: "skipped",
              durationMs: 0,
            },
          ],
          totalCount: 0,
          passedCount: 0,
          failedCount: 0,
          skippedCount: 1,
          dryRun: true,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      viewerHtmlPath,
      "<!doctype html><title>Scenario Dry Run</title><pre>Scenario dry run manifest only.</pre>\n",
      "utf8",
    );
    await writeScenarioNativeManifest({
      outputDir,
      runId,
      scenario: options.scenario,
      nativeJsonlPath,
      dryRun: true,
    });
    return {
      workspaceRoot,
      scenarioRunnerRoot,
      scenarioDir,
      outputDir,
      runId,
      matrixPath,
      viewerHtmlPath,
      nativeJsonlPath,
      nativeManifestPath,
      command: [command, ...args],
      env,
      stdout: "[DRY RUN] Would run scenario runner.",
      stderr: "",
      exitCode: 0,
    };
  }

  const proc = await collectProcess(command, args, scenarioRunnerRoot, {
    ...process.env,
    ...env,
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `eliza-scenarios exited with code ${proc.exitCode}: ${
        proc.stderr || proc.stdout
      }`,
    );
  }
  await writeScenarioNativeManifest({
    outputDir,
    runId,
    scenario: options.scenario,
    nativeJsonlPath,
    dryRun: false,
  });
  return {
    workspaceRoot,
    scenarioRunnerRoot,
    scenarioDir,
    outputDir,
    runId,
    matrixPath,
    viewerHtmlPath,
    nativeJsonlPath,
    nativeManifestPath,
    command: [command, ...args],
    env,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exitCode: proc.exitCode,
  };
}

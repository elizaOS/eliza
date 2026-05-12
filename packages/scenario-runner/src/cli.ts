/**
 * `eliza-scenarios` CLI. Two commands:
 *
 *   run  <dir> [--report <path>] [--report-dir <dir>] [--runId <id>] [--scenario <id,id,...>] [fileGlob ...]
 *   list <dir> [fileGlob ...]
 *
 * Exit codes:
 *   0  all scenarios passed (or skipped with SKIP_REASON set)
 *   1  at least one scenario failed
 *   2  configuration error (no LLM key, bad args, silent skip without reason)
 */

import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { listScenarioMetadata, loadAllScenarios } from "./loader.ts";
import type { ScenarioReport } from "./types.ts";

type ExecutorModule = typeof import("./executor.ts");
type ReporterModule = typeof import("./reporter.ts");
type NativeExportModule = typeof import("./native-export.ts");
type LiveProviderModule = {
  availableProviderNames: () => readonly string[];
};
type ScenarioRuntimeFactoryModule = {
  createScenarioRuntime: () => Promise<{
    runtime: AgentRuntime;
    providerName: string;
    cleanup: () => Promise<void>;
  }>;
};

interface ParsedArgs {
  command: "run" | "list";
  dir: string;
  reportPath?: string;
  reportDir?: string;
  runDir?: string;
  exportNativePath?: string;
  runId?: string;
  filter?: Set<string>;
  fileGlobs?: string[];
}

function usageAndExit(message: string, code: number): never {
  process.stderr.write(`[eliza-scenarios] ${message}\n`);
  process.stderr.write(
    "Usage:\n  eliza-scenarios run  <dir> [--run-dir <dir>] [--export-native <jsonlPath>] [--report <jsonPath>] [--report-dir <dir>] [--runId <id>] [--scenario id1,id2] [fileGlob ...]\n  eliza-scenarios list <dir> [fileGlob ...]\n",
  );
  process.exit(code);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length < 2) {
    usageAndExit("missing command or directory", 2);
  }
  const command = argv[0];
  if (command !== "run" && command !== "list") {
    usageAndExit(`unknown command '${command}'`, 2);
  }
  const dir = argv[1];
  if (!dir || dir.startsWith("--")) {
    usageAndExit("missing scenario directory", 2);
  }
  let reportPath: string | undefined;
  let reportDir: string | undefined;
  let runDir: string | undefined;
  let exportNativePath: string | undefined;
  let runId: string | undefined;
  let filter: Set<string> | undefined;
  const fileGlobs: string[] = [];
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      usageAndExit("unexpected empty argument", 2);
    }
    if (arg === "--report") {
      const next = argv[i + 1];
      if (!next) usageAndExit("--report missing value", 2);
      reportPath = next;
      i += 1;
    } else if (arg === "--report-dir") {
      const next = argv[i + 1];
      if (!next) usageAndExit("--report-dir missing value", 2);
      reportDir = next;
      i += 1;
    } else if (arg === "--run-dir") {
      const next = argv[i + 1];
      if (!next) usageAndExit("--run-dir missing value", 2);
      runDir = next;
      i += 1;
    } else if (arg === "--export-native") {
      const next = argv[i + 1];
      if (!next) usageAndExit("--export-native missing value", 2);
      exportNativePath = next;
      i += 1;
    } else if (arg === "--runId") {
      const next = argv[i + 1];
      if (!next) usageAndExit("--runId missing value", 2);
      runId = next;
      i += 1;
    } else if (arg === "--scenario") {
      const next = argv[i + 1];
      if (!next) usageAndExit("--scenario missing value", 2);
      const ids = next
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      filter = new Set(ids);
      i += 1;
    } else if (arg.startsWith("--")) {
      usageAndExit(`unknown flag '${arg}'`, 2);
    } else {
      fileGlobs.push(arg);
    }
  }
  return {
    command: command as "run" | "list",
    dir: path.resolve(dir),
    reportPath: reportPath ? path.resolve(reportPath) : undefined,
    reportDir: reportDir ? path.resolve(reportDir) : undefined,
    runDir: runDir ? path.resolve(runDir) : undefined,
    exportNativePath: exportNativePath ? path.resolve(exportNativePath) : undefined,
    runId,
    filter,
    fileGlobs,
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  if (parsed.command === "list") {
    const loaded = await listScenarioMetadata(
      parsed.dir,
      parsed.filter,
      parsed.fileGlobs,
    );
    for (const scenario of loaded) {
      process.stdout.write(`${scenario.id}\n`);
    }
    return 0;
  }

  const liveProviderSpecifier = "@elizaos/core" as string;
  const runtimeFactorySpecifier: string = "./runtime-factory.ts";
  const [
    { availableProviderNames },
    { runScenario },
    { buildAggregate, printStdoutSummary, writeReport, writeReportBundle },
    { createScenarioRuntime },
    { exportScenarioNativeJsonl },
    // Keep out-of-root imports behind widened specifiers so TypeScript does not
    // pull those modules into this package's rootDir validation graph.
  ]: [
    LiveProviderModule,
    ExecutorModule,
    ReporterModule,
    ScenarioRuntimeFactoryModule,
    NativeExportModule,
  ] = await Promise.all([
    import(liveProviderSpecifier),
    import("./executor.ts"),
    import("./reporter.ts"),
    import(runtimeFactorySpecifier),
    import("./native-export.ts"),
  ]);

  if (availableProviderNames().length === 0) {
    process.stderr.write(
      "[eliza-scenarios] no LLM provider API key set; refusing to run (WS7 policy: fail loudly on silent credential skips).\n  Set one of: GROQ_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY.\n",
    );
    return 2;
  }

  const minJudgeScore = Number.parseFloat(
    process.env.LIFEOPS_LIVE_JUDGE_MIN_SCORE ?? "0.8",
  );
  if (!Number.isFinite(minJudgeScore) || minJudgeScore <= 0) {
    process.stderr.write(
      `[eliza-scenarios] invalid LIFEOPS_LIVE_JUDGE_MIN_SCORE=${process.env.LIFEOPS_LIVE_JUDGE_MIN_SCORE}\n`,
    );
    return 2;
  }

  const loaded = await loadAllScenarios(
    parsed.dir,
    parsed.filter,
    parsed.fileGlobs,
  );
  if (loaded.length === 0) {
    process.stderr.write(
      `[eliza-scenarios] no scenarios discovered under ${parsed.dir}${parsed.filter ? ` (filter=${[...parsed.filter].join(",")})` : ""}${parsed.fileGlobs && parsed.fileGlobs.length > 0 ? ` (fileGlobs=${parsed.fileGlobs.join(",")})` : ""}\n`,
    );
    return 2;
  }

  logger.info(
    `[eliza-scenarios] discovered ${loaded.length} scenario(s) under ${parsed.dir}`,
  );

  const startedAtIso = new Date().toISOString();

  // Run-level results dir. When set, every scenario in this run drops its
  // trajectories under <runDir>/trajectories/ and the aggregator post-step
  // can produce per-scenario JSONL + report.md + steps.csv. Also exports
  // MILADY_LIFEOPS_RUN_ID so the recorder picks it up.
  //
  // `--export-native` needs those trajectory files too; if it was given
  // without an explicit `--run-dir`, default one next to the export target so
  // the recorder still captures the per-turn traces we then convert.
  const effectiveRunId = parsed.runId ?? crypto.randomUUID();
  const effectiveRunDir =
    parsed.runDir ??
    (parsed.exportNativePath
      ? path.join(
          path.dirname(parsed.exportNativePath),
          `scenario-run-${effectiveRunId}`,
        )
      : undefined);
  if (effectiveRunDir) {
    const trajectoryDir = path.join(effectiveRunDir, "trajectories");
    process.env.MILADY_TRAJECTORY_DIR = trajectoryDir;
    process.env.MILADY_LIFEOPS_RUN_ID = effectiveRunId;
    process.env.MILADY_LIFEOPS_RUN_DIR = effectiveRunDir;
    logger.info(
      `[eliza-scenarios] run-dir: ${effectiveRunDir} (trajectories → ${trajectoryDir}, runId=${effectiveRunId})`,
    );
  }

  // Note: a single bun process can only instantiate PGLite once reliably —
  // attempting to tear down and recreate the native binding segfaults. So the
  // CLI always uses a single shared runtime. For true per-scenario isolation
  // (required when testing cross-scenario state leakage), invoke the CLI
  // once per scenario from a shell loop (see scripts/run-scenarios-isolated.mjs).
  const { runtime, providerName, cleanup } = await createScenarioRuntime();
  logger.info(`[eliza-scenarios] live provider: ${providerName}`);

  const reports: ScenarioReport[] = [];
  try {
    for (const { scenario } of loaded) {
      logger.info(`[eliza-scenarios] ▶ ${scenario.id}`);
      // Surface scenario id to the recorder via env so trajectories are
      // tagged with the right scenarioId without changing internal APIs.
      process.env.MILADY_LIFEOPS_SCENARIO_ID = scenario.id;
      const report = await runScenario(scenario, runtime, {
        providerName,
        minJudgeScore,
        turnTimeoutMs: 120_000,
      });
      reports.push(report);
      logger.info(
        `[eliza-scenarios] ${report.status === "passed" ? "✓" : report.status === "skipped" ? "∼" : "✗"} ${scenario.id} ${report.status} (${report.durationMs}ms)${report.skipReason ? ` — ${report.skipReason}` : ""}`,
      );
    }
  } finally {
    await cleanup();
  }

  const completedAtIso = new Date().toISOString();
  const aggregate = buildAggregate(
    reports,
    providerName,
    startedAtIso,
    completedAtIso,
    effectiveRunId,
  );

  if (parsed.reportPath) {
    writeReport(aggregate, parsed.reportPath);
  }
  if (parsed.reportDir) {
    writeReportBundle(aggregate, parsed.reportDir);
  }
  if (effectiveRunDir) {
    // Drop the matrix.json next to trajectories/ so the aggregator can find it.
    const matrixPath = path.join(effectiveRunDir, "matrix.json");
    writeReport(aggregate, matrixPath);
  }
  if (parsed.exportNativePath && effectiveRunDir) {
    // Convert the recorded per-turn trajectory JSON under <runDir>/trajectories/
    // into canonical eliza_native_v1 model-boundary rows for the eliza-1
    // training corpus (see packages/training/docs/dataset/CANONICAL_RECORD.md).
    // The training prep script runs the mandatory privacy filter on every row.
    exportScenarioNativeJsonl(effectiveRunDir, parsed.exportNativePath);
  }
  printStdoutSummary(aggregate);

  // SKIP_REASON guard: if any scenarios skipped and no SKIP_REASON is set, fail.
  const skipReason = (process.env.SKIP_REASON ?? "").trim();
  if (aggregate.totals.skipped > 0 && skipReason.length === 0) {
    process.stderr.write(
      `[eliza-scenarios] ${aggregate.totals.skipped} scenario(s) skipped without SKIP_REASON — failing loudly per WS7 policy.\n`,
    );
    return 2;
  }

  return aggregate.totals.failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `[eliza-scenarios] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });

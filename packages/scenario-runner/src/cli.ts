/**
 * `eliza-scenarios` CLI. Two commands:
 *
 *   run  <dir> [--report <path>] [--report-dir <dir>] [--runId <id>] [--scenario <id,id,...>] [--lane <name>] [fileGlob ...]
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
import { logger } from "@elizaos/core";
import {
  DEFAULT_SCENARIO_LANE,
  type ScenarioLane,
} from "@elizaos/scenario-runner/schema";
import {
  countScenarioCorpus,
  listScenarioMetadata,
  loadAllScenarios,
  validateScenarioCorpus,
} from "./loader.ts";
import type { ScenarioReport } from "./types.ts";

const SCENARIO_LANES: readonly ScenarioLane[] = [
  "pr-deterministic",
  "live-only",
];

function isScenarioLane(value: string): value is ScenarioLane {
  return (SCENARIO_LANES as readonly string[]).includes(value);
}

type ExecutorModule = typeof import("./executor.ts");
type ReporterModule = typeof import("./reporter.ts");
type NativeExportModule = typeof import("./native-export.ts");
type LiveProviderModule = {
  availableProviderNames: () => readonly string[];
};
type ScenarioRuntimeFactoryModule = Pick<
  typeof import("./runtime-factory.ts"),
  "createScenarioRuntime" | "shouldUseDeterministicLlmProxy"
>;

interface ParsedArgs {
  command: "run" | "list";
  dir: string;
  reportPath?: string;
  reportDir?: string;
  runDir?: string;
  exportNativePath?: string;
  runId?: string;
  filter?: Set<string>;
  lane?: ScenarioLane;
  fileGlobs?: string[];
  expandScenarios?: boolean;
  countScenarios?: boolean;
  validateScenarios?: boolean;
}

function scenarioNativeManifestPath(
  nativeJsonlPath?: string,
): string | undefined {
  if (!nativeJsonlPath) return undefined;
  return nativeJsonlPath.endsWith(".jsonl")
    ? `${nativeJsonlPath.slice(0, -".jsonl".length)}.manifest.json`
    : `${nativeJsonlPath}.manifest.json`;
}

function usageAndExit(message: string, code: number): never {
  process.stderr.write(`[eliza-scenarios] ${message}\n`);
  process.stderr.write(
    "Usage:\n  eliza-scenarios run  <dir> [--expand-scenarios] [--count-scenarios] [--validate-scenarios] [--run-dir <dir>] [--export-native <jsonlPath>] [--report <jsonPath>] [--report-dir <dir>] [--runId <id>] [--scenario id1,id2] [--lane pr-deterministic|live-only] [fileGlob ...]\n  eliza-scenarios list <dir> [--expand-scenarios] [--count-scenarios] [--validate-scenarios] [--lane pr-deterministic|live-only] [fileGlob ...]\n",
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
  let lane: ScenarioLane | undefined;
  let expandScenarios = false;
  let countScenarios = false;
  let validateScenarios = false;
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
    } else if (arg === "--lane") {
      const next = argv[i + 1];
      if (!next) usageAndExit("--lane missing value", 2);
      if (!isScenarioLane(next)) {
        usageAndExit(
          `--lane must be one of ${SCENARIO_LANES.join(", ")} (got '${next}')`,
          2,
        );
      }
      lane = next;
      i += 1;
    } else if (arg === "--expand-scenarios") {
      expandScenarios = true;
    } else if (arg === "--count-scenarios") {
      countScenarios = true;
    } else if (arg === "--validate-scenarios") {
      validateScenarios = true;
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
    exportNativePath: exportNativePath
      ? path.resolve(exportNativePath)
      : undefined,
    runId,
    filter,
    lane,
    fileGlobs,
    expandScenarios,
    countScenarios,
    validateScenarios,
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  if (parsed.countScenarios) {
    const counts = await countScenarioCorpus(
      parsed.dir,
      parsed.filter,
      parsed.fileGlobs,
    );
    process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
    return 0;
  }

  if (parsed.validateScenarios) {
    const validation = await validateScenarioCorpus(
      parsed.dir,
      parsed.filter,
      parsed.fileGlobs,
    );
    process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
    return 0;
  }

  if (parsed.command === "list") {
    const loaded = await listScenarioMetadata(
      parsed.dir,
      parsed.filter,
      parsed.fileGlobs,
      parsed.expandScenarios,
      parsed.lane,
    );
    const requestedLane = parsed.lane;
    const selected = requestedLane
      ? loaded.filter(
          (scenario) =>
            (scenario.lane ?? DEFAULT_SCENARIO_LANE) === requestedLane,
        )
      : loaded;
    for (const scenario of selected) {
      process.stdout.write(`${scenario.id}\n`);
    }
    return 0;
  }

  const liveProviderSpecifier = "@elizaos/core/testing" as string;
  const [
    { availableProviderNames },
    { runScenario },
    {
      buildAggregate,
      printStdoutSummary,
      writeReport,
      writeReportBundle,
      writeScenarioRunViewer,
    },
    { createScenarioRuntime, shouldUseDeterministicLlmProxy },
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
    import("./runtime-factory.ts"),
    import("./native-export.ts"),
  ]);

  if (
    availableProviderNames().length === 0 &&
    !shouldUseDeterministicLlmProxy()
  ) {
    process.stderr.write(
      "[eliza-scenarios] no LLM provider API key set; refusing to run (WS7 policy: fail loudly on silent credential skips).\n  Set one of: GROQ_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY,\n  or on a subscription-only host set ELIZA_CHAT_VIA_CLI=claude|claude-sdk|codex|codex-sdk (requires the CLI's own on-disk credentials),\n  or enable deterministic test mode with SCENARIO_USE_LLM_PROXY=1.\n",
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
    parsed.expandScenarios,
    parsed.lane,
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
  // ELIZA_LIFEOPS_RUN_ID so the recorder picks it up.
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
    process.env.ELIZA_TRAJECTORY_DIR = trajectoryDir;
    process.env.ELIZA_LIFEOPS_RUN_ID = effectiveRunId;
    process.env.ELIZA_LIFEOPS_RUN_DIR = effectiveRunDir;
    // The recorder default flipped to opt-in for prod/test (#13775); a scenario
    // run capturing trajectories must opt in explicitly so the per-turn traces
    // this run then aggregates/exports are actually written.
    process.env.ELIZA_TRAJECTORY_LOGGING = "1";
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
  logger.info(`[eliza-scenarios] provider: ${providerName}`);

  // Per-turn timeout. Defaults to 120s (fast hosted providers), but a real
  // local model on a CPU backend needs a larger budget; expose it via env so
  // the local-model bench lane can run without editing this file.
  const turnTimeoutMs = (() => {
    const raw = process.env.SCENARIO_TURN_TIMEOUT_MS?.trim();
    if (!raw) return 120_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `SCENARIO_TURN_TIMEOUT_MS must be a positive integer (got '${raw}')`,
      );
    }
    return parsed;
  })();

  const reports: ScenarioReport[] = [];
  try {
    for (const { scenario } of loaded) {
      logger.info(`[eliza-scenarios] ▶ ${scenario.id}`);
      // Surface scenario id to the recorder via env so trajectories are
      // tagged with the right scenarioId without changing internal APIs.
      process.env.ELIZA_LIFEOPS_SCENARIO_ID = scenario.id;
      const report = await runScenario(scenario, runtime, {
        providerName,
        minJudgeScore,
        turnTimeoutMs,
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
    // Sum real per-trajectory spend from <runDir>/trajectories/ so
    // matrix.json's totalCostUsd reflects the run instead of a hardcoded 0.
    effectiveRunDir,
  );

  if (parsed.exportNativePath && effectiveRunDir) {
    // Convert the recorded per-turn trajectory JSON under <runDir>/trajectories/
    // into canonical eliza_native_v1 model-boundary rows for the eliza-1
    // training corpus (see packages/training/docs/dataset/CANONICAL_RECORD.md).
    // The training prep script runs the mandatory privacy filter on every row.
    // Thread each scenario's assertion outcome so failed/regressed trajectories
    // are stamped status="failed" and routed to rating="repair"/weight=0 instead
    // of being exported as gold-weight training data.
    const scenarioOutcomes = new Map(
      reports.map((report) => [report.id, report.status] as const),
    );
    // Thread the numeric judge score (minimum across judged turns + rubric
    // final checks) so rows carry metadata.judge_score for reward-weighted
    // training (#8795).
    const scenarioJudgeScores = new Map<string, number>();
    const scenarioTiers = new Map<string, string>();
    for (const report of reports) {
      if (typeof report.judgeScore === "number") {
        scenarioJudgeScores.set(report.id, report.judgeScore);
      }
      if (typeof report.tier === "string") {
        scenarioTiers.set(report.id, report.tier);
      }
    }
    exportScenarioNativeJsonl(
      effectiveRunDir,
      parsed.exportNativePath,
      scenarioOutcomes,
      scenarioJudgeScores,
      scenarioTiers,
    );
  }
  if (effectiveRunDir) {
    const viewerIndex = path.join(effectiveRunDir, "viewer", "index.html");
    const viewerData = path.join(effectiveRunDir, "viewer", "data.js");
    aggregate.artifactPaths = {
      runDir: effectiveRunDir,
      matrixJson: path.join(effectiveRunDir, "matrix.json"),
      viewerIndex,
      viewerData,
      ...(parsed.exportNativePath
        ? {
            nativeJsonl: parsed.exportNativePath,
            nativeManifest: scenarioNativeManifestPath(parsed.exportNativePath),
          }
        : {}),
    };
    writeScenarioRunViewer(aggregate, effectiveRunDir, {
      nativeJsonlPath: parsed.exportNativePath,
    });
  }
  if (parsed.reportPath) {
    writeReport(aggregate, parsed.reportPath);
  }
  if (parsed.reportDir) {
    writeReportBundle(aggregate, parsed.reportDir);
  }
  if (effectiveRunDir) {
    // Drop the matrix.json next to trajectories/ so the aggregator can find it.
    writeReport(aggregate, path.join(effectiveRunDir, "matrix.json"));
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

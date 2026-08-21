/**
 * `eliza-scenarios` CLI. Two commands:
 *
 *   run  <dir> [--report <path>] [--report-dir <dir>] [--runId <id>] [--scenario <id,id,...>] [--lane <name>] [--provider <name>] [fileGlob ...]
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
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";
import type { LiveProviderName } from "@elizaos/core/testing";
import {
  DEFAULT_SCENARIO_LANE,
  type ScenarioDefinition,
  type ScenarioExecutionProfile,
  type ScenarioLane,
  scenarioExecutionProfile,
} from "@elizaos/scenario-runner/schema";
import { captureHostExecutionBaseline } from "@elizaos/shared/host-execution-env";
import {
  countScenarioCorpus,
  listScenarioMetadata,
  loadAllScenarios,
  validateScenarioCorpus,
} from "./loader.ts";
import { canonicalJsonValue } from "./provider-qualified/manifest.ts";
import { redactForScenarioReport } from "./redaction.ts";
import {
  assertSharedRuntimePluginBatchSafe,
  resolveRequiredPluginPackages,
} from "./required-plugins.ts";
import { shouldOptInScenarioTrajectoryLogging } from "./trajectory-opt-in.ts";
import type { AggregateReport, ScenarioReport } from "./types.ts";

const SCENARIO_LANES: readonly ScenarioLane[] = [
  "pr-deterministic",
  "live-only",
];

const LIVE_PROVIDER_NAMES = [
  "groq",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "cli",
] as const satisfies readonly LiveProviderName[];

function isScenarioLane(value: string): value is ScenarioLane {
  return (SCENARIO_LANES as readonly string[]).includes(value);
}

function isLiveProviderName(value: string): value is LiveProviderName {
  return (LIVE_PROVIDER_NAMES as readonly string[]).includes(value);
}

export function resolveRunExecutionProfile(
  scenarios: readonly ScenarioDefinition[],
): ScenarioExecutionProfile {
  const profiles = new Set(scenarios.map(scenarioExecutionProfile));
  if (profiles.size !== 1) {
    throw new CliUsageError(
      "a scenario run cannot mix simulated and provider-qualified execution; select one profile per invocation",
      2,
    );
  }
  const profile = profiles.values().next().value;
  if (profile === undefined) {
    throw new CliUsageError("a scenario run requires at least one scenario", 2);
  }
  if (profile === "provider-qualified" && scenarios.length !== 1) {
    throw new CliUsageError(
      "provider-qualified execution requires exactly one scenario per process so runtime, database, observer interval, and trajectories are isolated",
      2,
    );
  }
  return profile;
}

/**
 * Provider execution remains nonpublishable until an out-of-process controller
 * verifies the signed manifest, observer evidence, and retained artifacts. A
 * scenario report is runner-authored data and cannot serve as that decision.
 */
export function providerQualifiedRunFailure(
  reports: readonly ScenarioReport[],
): string | null {
  if (reports.length !== 1) {
    return `provider-qualified execution must finish with exactly one report; received ${reports.length}`;
  }
  const report = reports[0];
  if (report?.status !== "passed") {
    return "provider-qualified execution did not finish with a passed scenario";
  }
  return "provider-qualified execution has no external controller decision; scenario-authored reports cannot establish publishability";
}

const CLI_EXTERNAL_QUALIFICATION_REASON =
  "external-controller-decision:missing" as const;

/**
 * Drop keys whose value is literally `undefined`, recursively.
 *
 * `canonicalJsonValue` rejects `undefined` on purpose: a canonical encoding must
 * be unambiguous, and `{ text: undefined }` and `{}` hash differently as objects
 * while serializing identically as JSON. The report builders, though, assign
 * `undefined` to absent optional fields (`text`, `error`, `screenshot`, …) — the
 * ordinary TypeScript way to say "not present" — so a perfectly well-formed
 * report aborted the run with "contains executable or non-JSON data (undefined)".
 *
 * Omitting those keys is semantically lossless: absent and undefined mean the
 * same thing here, and `JSON.stringify` already erases the distinction. This
 * deliberately does NOT touch functions, symbols, bigints, or cycles — those
 * still reach the validator and still fail the run, which is the guard's actual
 * purpose. Normalizing them away would hide executable data leaking into an
 * attestable artifact.
 */
function omitUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefinedDeep);
  if (value === null || typeof value !== "object") return value;
  // Only plain objects: a class instance's prototype is itself a signal the
  // validator should see, not something to quietly rebuild into a bare object.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    out[key] = omitUndefinedDeep(item);
  }
  return out;
}

function snapshotScenarioReport(report: ScenarioReport): ScenarioReport {
  return canonicalJsonValue(
    omitUndefinedDeep(report),
    "scenarioReport",
  ) as unknown as ScenarioReport;
}

function normalizeOrdinaryCliProviderEvidence(
  report: ScenarioReport,
): ScenarioReport {
  const snapshot = snapshotScenarioReport(report);
  const evidence = snapshot.evidence;
  if (evidence?.executionProfile !== "provider-qualified") {
    return snapshot;
  }
  if (
    evidence.qualification.status === "unqualified" &&
    evidence.qualification.reasons.includes(CLI_EXTERNAL_QUALIFICATION_REASON)
  ) {
    return snapshot;
  }
  const reasons: readonly [string, ...string[]] = [
    CLI_EXTERNAL_QUALIFICATION_REASON,
    ...(evidence.qualification.status === "unqualified"
      ? evidence.qualification.reasons.filter(
          (reason) => reason !== CLI_EXTERNAL_QUALIFICATION_REASON,
        )
      : []),
  ];
  return {
    ...snapshot,
    evidence: {
      ...evidence,
      qualification: {
        status: "unqualified",
        publishable: false,
        reasons,
      },
    },
  };
}

type ExecutorModule = typeof import("./executor.ts");
type ReporterModule = typeof import("./reporter.ts");
type NativeExportModule = typeof import("./native-export.ts");
type LiveProviderModule = {
  availableProviderNames: () => readonly string[];
};
type ScenarioRuntimeFactoryModule = Pick<
  typeof import("./runtime-factory.ts"),
  | "createScenarioRuntime"
  | "scenarioLiveProviderPreflightProblems"
  | "shouldUseDeterministicModel"
>;

export interface ParsedArgs {
  command: "run" | "list";
  dir: string;
  reportPath?: string;
  reportDir?: string;
  runDir?: string;
  exportNativePath?: string;
  runId?: string;
  filter?: Set<string>;
  lane?: ScenarioLane;
  provider?: LiveProviderName;
  fileGlobs?: string[];
  expandScenarios?: boolean;
  countScenarios?: boolean;
  validateScenarios?: boolean;
}

export class CliUsageError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "CliUsageError";
    this.exitCode = exitCode;
  }
}

export interface CliDependencies {
  availableProviderNames: LiveProviderModule["availableProviderNames"];
  runScenario: ExecutorModule["runScenario"];
  buildAggregate: ReporterModule["buildAggregate"];
  printStdoutSummary: ReporterModule["printStdoutSummary"];
  writeReport: ReporterModule["writeReport"];
  writeReportBundle: ReporterModule["writeReportBundle"];
  writeScenarioRunViewer: ReporterModule["writeScenarioRunViewer"];
  createScenarioRuntime: ScenarioRuntimeFactoryModule["createScenarioRuntime"];
  scenarioLiveProviderPreflightProblems: ScenarioRuntimeFactoryModule["scenarioLiveProviderPreflightProblems"];
  shouldUseDeterministicModel: ScenarioRuntimeFactoryModule["shouldUseDeterministicModel"];
  exportScenarioNativeJsonl: NativeExportModule["exportScenarioNativeJsonl"];
}

type EvidencePaths = {
  reportPath?: string;
  reportDir?: string;
  runDir?: string;
  nativeJsonlPath?: string;
};

function scenarioOutcomeMaps(reports: readonly ScenarioReport[]): {
  outcomes: Map<string, ScenarioReport["status"]>;
  judgeScores: Map<string, number>;
  tiers: Map<string, string>;
} {
  const outcomes = new Map(
    reports.map((report) => [report.id, report.status] as const),
  );
  const judgeScores = new Map<string, number>();
  const tiers = new Map<string, string>();
  for (const report of reports) {
    if (typeof report.judgeScore === "number") {
      judgeScores.set(report.id, report.judgeScore);
    }
    if (typeof report.tier === "string") {
      tiers.set(report.id, report.tier);
    }
  }
  return { outcomes, judgeScores, tiers };
}

function attachArtifactPaths(
  aggregate: AggregateReport,
  paths: EvidencePaths,
): void {
  if (!paths.runDir) return;
  const viewerIndex = path.join(paths.runDir, "viewer", "index.html");
  const viewerData = path.join(paths.runDir, "viewer", "data.js");
  aggregate.artifactPaths = {
    runDir: paths.runDir,
    matrixJson: path.join(paths.runDir, "matrix.json"),
    viewerIndex,
    viewerData,
    ...(paths.nativeJsonlPath
      ? {
          nativeJsonl: paths.nativeJsonlPath,
          nativeManifest: scenarioNativeManifestPath(paths.nativeJsonlPath),
        }
      : {}),
  };
}

function writeScenarioEvidence(params: {
  aggregate: AggregateReport;
  reports: readonly ScenarioReport[];
  paths: EvidencePaths;
  finalize: boolean;
  dependencies: Pick<
    CliDependencies,
    | "exportScenarioNativeJsonl"
    | "writeReport"
    | "writeReportBundle"
    | "writeScenarioRunViewer"
  >;
}): void {
  const { aggregate, reports, paths, finalize, dependencies } = params;
  const persistedAggregate = redactForScenarioReport(
    canonicalJsonValue(omitUndefinedDeep(aggregate), "aggregateReport"),
  ) as AggregateReport;

  // Checkpoints deliberately write only the bounded evidence needed for crash
  // recovery. Native export and the viewer scan every recorded trajectory, and
  // a full report bundle rewrites every preceding scenario, so doing those on
  // every iteration would make a long run quadratic. Finalization regenerates
  // those derived artifacts deterministically from the same aggregate.
  if (finalize && paths.nativeJsonlPath && paths.runDir) {
    const { outcomes, judgeScores, tiers } = scenarioOutcomeMaps(reports);
    dependencies.exportScenarioNativeJsonl(
      paths.runDir,
      paths.nativeJsonlPath,
      outcomes,
      judgeScores,
      tiers,
    );
  }
  attachArtifactPaths(persistedAggregate, paths);
  if (finalize && paths.runDir) {
    dependencies.writeScenarioRunViewer(persistedAggregate, paths.runDir, {
      nativeJsonlPath: paths.nativeJsonlPath,
    });
  }
  if (paths.reportPath) {
    dependencies.writeReport(persistedAggregate, paths.reportPath);
  }
  if (paths.reportDir) {
    if (finalize) {
      dependencies.writeReportBundle(persistedAggregate, paths.reportDir);
    } else {
      dependencies.writeReport(
        persistedAggregate,
        path.join(paths.reportDir, "matrix.json"),
      );
    }
  }
  if (paths.runDir) {
    dependencies.writeReport(
      persistedAggregate,
      path.join(paths.runDir, "matrix.json"),
    );
  }
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
  throw new CliUsageError(message, code);
}

function formatUsageError(error: CliUsageError): string {
  return (
    `[eliza-scenarios] ${error.message}\n` +
    "Usage:\n  eliza-scenarios run  <dir> [--expand-scenarios] [--count-scenarios] [--validate-scenarios] [--run-dir <dir>] [--export-native <jsonlPath>] [--report <jsonPath>] [--report-dir <dir>] [--runId <id>] [--scenario id1,id2] [--lane pr-deterministic|live-only] [--provider groq|openai|anthropic|google|openrouter|cli] [fileGlob ...]\n  eliza-scenarios list <dir> [--expand-scenarios] [--count-scenarios] [--validate-scenarios] [--lane pr-deterministic|live-only] [fileGlob ...]\n"
  );
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
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
  let provider: LiveProviderName | undefined;
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
    } else if (arg === "--provider") {
      const next = argv[i + 1];
      if (!next) usageAndExit("--provider missing value", 2);
      if (!isLiveProviderName(next)) {
        usageAndExit(
          `--provider must be one of ${LIVE_PROVIDER_NAMES.join(", ")} (got '${next}')`,
          2,
        );
      }
      provider = next;
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
    provider,
    fileGlobs,
    expandScenarios,
    countScenarios,
    validateScenarios,
  };
}

async function loadCliDependencies(): Promise<CliDependencies> {
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
    {
      createScenarioRuntime,
      scenarioLiveProviderPreflightProblems,
      shouldUseDeterministicModel,
    },
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
  return {
    availableProviderNames,
    runScenario,
    buildAggregate,
    printStdoutSummary,
    writeReport,
    writeReportBundle,
    writeScenarioRunViewer,
    createScenarioRuntime,
    scenarioLiveProviderPreflightProblems,
    shouldUseDeterministicModel,
    exportScenarioNativeJsonl,
  };
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies?: CliDependencies,
): Promise<number> {
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
    if (parsed.provider) {
      usageAndExit("--provider is only valid with the run command", 2);
    }
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

  const {
    availableProviderNames,
    runScenario,
    buildAggregate,
    printStdoutSummary,
    writeReport,
    writeReportBundle,
    writeScenarioRunViewer,
    createScenarioRuntime,
    scenarioLiveProviderPreflightProblems,
    shouldUseDeterministicModel,
    exportScenarioNativeJsonl,
  } = dependencies ?? (await loadCliDependencies());

  const deterministicModelEnabled = shouldUseDeterministicModel();
  const configuredProviders = availableProviderNames();
  if (parsed.provider && deterministicModelEnabled) {
    process.stderr.write(
      `[eliza-scenarios] --provider ${parsed.provider} cannot be combined with deterministic model mode.\n`,
    );
    return 2;
  }
  if (!deterministicModelEnabled) {
    const preflightProblems = scenarioLiveProviderPreflightProblems(
      parsed.provider,
    );
    if (preflightProblems.length > 0) {
      process.stderr.write(
        `[eliza-scenarios] live provider preflight failed: ${preflightProblems.join("; ")}\n`,
      );
      return 2;
    }
  }
  if (parsed.provider && !configuredProviders.includes(parsed.provider)) {
    process.stderr.write(
      `[eliza-scenarios] requested provider ${parsed.provider} is unavailable; configured providers: ${configuredProviders.join(", ") || "(none)"}.\n`,
    );
    return 2;
  }
  if (configuredProviders.length === 0 && !deterministicModelEnabled) {
    process.stderr.write(
      "[eliza-scenarios] no LLM provider API key set; refusing to run (WS7 policy: fail loudly on silent credential skips).\n  Set one of: GROQ_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY,\n  or on a subscription-only host set ELIZA_CHAT_VIA_CLI=claude|claude-sdk|codex|codex-sdk (requires the CLI's own on-disk credentials),\n  or enable deterministic test mode with SCENARIO_USE_DETERMINISTIC_MODEL=1.\n",
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
  let executionProfile: ScenarioExecutionProfile;
  try {
    executionProfile = resolveRunExecutionProfile(
      loaded.map(({ scenario }) => scenario),
    );
  } catch (error) {
    // error-policy:J1 CLI usage boundary maps profile conflicts to exit codes.
    if (error instanceof CliUsageError) {
      process.stderr.write(`[eliza-scenarios] ${error.message}\n`);
      return error.exitCode;
    }
    throw error;
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
  if (executionProfile === "provider-qualified" && !effectiveRunDir) {
    process.stderr.write(
      "[eliza-scenarios] provider-qualified execution requires --run-dir or --export-native so immutable trajectory artifacts can be hashed and retained.\n",
    );
    return 2;
  }
  // Opt the recorder in for the whole run (see the helper's rationale) — this
  // is hoisted out of the `effectiveRunDir` branch so a bare run under
  // NODE_ENV=test|production still captures the per-turn traces it aggregates.
  // The recorder falls back to `${stateDir}/trajectories` when
  // ELIZA_TRAJECTORY_DIR is unset (resolveTrajectoryDir, trajectory-recorder.ts).
  if (shouldOptInScenarioTrajectoryLogging()) {
    process.env.ELIZA_TRAJECTORY_LOGGING = "1";
  }
  if (effectiveRunDir) {
    const trajectoryDir = path.join(effectiveRunDir, "trajectories");
    process.env.ELIZA_TRAJECTORY_DIR = trajectoryDir;
    process.env.ELIZA_LIFEOPS_RUN_ID = effectiveRunId;
    process.env.ELIZA_LIFEOPS_RUN_DIR = effectiveRunDir;
    logger.info(
      `[eliza-scenarios] run-dir: ${effectiveRunDir} (trajectories → ${trajectoryDir}, runId=${effectiveRunId})`,
    );
  }

  // PGLite is process-scoped. Simulated compatibility runs may share one
  // runtime, while provider-qualified runs are constrained above to a single
  // scenario so the observer interval and database cannot cross-contaminate.
  assertSharedRuntimePluginBatchSafe(loaded.map(({ scenario }) => scenario));
  const requiredPlugins = [
    ...new Set(
      loaded.flatMap(({ scenario }) => resolveRequiredPluginPackages(scenario)),
    ),
  ];
  const runtimeResult = await createScenarioRuntime({
    executionProfile,
    preferredProvider: parsed.provider,
    requiredPlugins,
  });
  const { runtime, providerName, cleanup } = runtimeResult;
  if (runtimeResult.executionProfile !== executionProfile) {
    await cleanup();
    throw new Error(
      `[eliza-scenarios] runtime factory returned execution profile ${runtimeResult.executionProfile} for a ${executionProfile} run`,
    );
  }
  logger.info(
    `[eliza-scenarios] provider: ${providerName}; execution profile: ${executionProfile}`,
  );

  // Per-turn timeout. Defaults to 120s (fast hosted providers), but a real
  // local model on a CPU backend needs a larger budget; expose it via env so
  // the local-model bench lane can run without editing this file.
  const turnTimeoutMs = (() => {
    const raw = process.env.SCENARIO_TURN_TIMEOUT_MS?.trim();
    if (!raw) return 120_000;
    // `Number.parseInt` stops at the first non-digit, so "500junk" parsed to a
    // finite, positive 500 and slipped past the guard below — silently running
    // every turn on a 500ms budget instead of failing the way this check
    // already intends to.
    const parsed = /^\+?\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(
        `SCENARIO_TURN_TIMEOUT_MS must be a positive integer (got '${raw}')`,
      );
    }
    return parsed;
  })();

  const reports: ScenarioReport[] = [];
  let interruptedSignal: NodeJS.Signals | undefined;
  const runAbortController = new AbortController();
  const onInterrupt = (signal: NodeJS.Signals): void => {
    interruptedSignal = signal;
    runAbortController.abort(
      new Error(`Scenario run interrupted by ${signal}`),
    );
    process.stderr.write(
      `[eliza-scenarios] received ${signal}; cancelling the current scenario, writing checkpoint evidence, then stopping.\n`,
    );
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  const evidencePaths: EvidencePaths = {
    reportPath: parsed.reportPath,
    reportDir: parsed.reportDir,
    runDir: effectiveRunDir,
    nativeJsonlPath: parsed.exportNativePath,
  };
  let latestAggregate: AggregateReport | undefined;
  const writeCheckpoint = (): AggregateReport => {
    const checkpoint = buildAggregate(
      reports,
      providerName,
      startedAtIso,
      new Date().toISOString(),
      effectiveRunId,
      effectiveRunDir,
    );
    writeScenarioEvidence({
      aggregate: checkpoint,
      reports,
      paths: evidencePaths,
      finalize: false,
      dependencies: {
        exportScenarioNativeJsonl,
        writeReport,
        writeReportBundle,
        writeScenarioRunViewer,
      },
    });
    latestAggregate = checkpoint;
    return checkpoint;
  };
  try {
    for (const { scenario } of loaded) {
      if (interruptedSignal) break;
      logger.info(`[eliza-scenarios] ▶ ${scenario.id}`);
      // Surface scenario id to the recorder via env so trajectories are
      // tagged with the right scenarioId without changing internal APIs.
      process.env.ELIZA_LIFEOPS_SCENARIO_ID = scenario.id;
      const rawReport = await runScenario(scenario, runtime, {
        providerName,
        minJudgeScore,
        turnTimeoutMs,
        abortSignal: runAbortController.signal,
        executionProfile,
        runDir: effectiveRunDir,
      });
      const report =
        executionProfile === "provider-qualified"
          ? normalizeOrdinaryCliProviderEvidence(rawReport)
          : snapshotScenarioReport(rawReport);
      reports.push(report);
      logger.info(
        `[eliza-scenarios] ${report.status === "passed" ? "✓" : report.status === "skipped" ? "∼" : "✗"} ${scenario.id} ${report.status} (${report.durationMs}ms)${report.skipReason ? ` — ${report.skipReason}` : ""}`,
      );
      writeCheckpoint();
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    await cleanup();
  }

  const aggregate =
    latestAggregate ??
    buildAggregate(
      reports,
      providerName,
      startedAtIso,
      new Date().toISOString(),
      effectiveRunId,
      // Sum real per-trajectory spend from <runDir>/trajectories/ so
      // matrix.json's totalCostUsd reflects the run instead of a hardcoded 0.
      effectiveRunDir,
    );
  const qualificationFailure =
    executionProfile === "provider-qualified"
      ? providerQualifiedRunFailure(reports)
      : null;
  const finalEvidencePaths =
    qualificationFailure === null
      ? evidencePaths
      : { ...evidencePaths, nativeJsonlPath: undefined };
  writeScenarioEvidence({
    aggregate,
    reports,
    paths: finalEvidencePaths,
    finalize: true,
    dependencies: {
      exportScenarioNativeJsonl,
      writeReport,
      writeReportBundle,
      writeScenarioRunViewer,
    },
  });
  printStdoutSummary(aggregate);

  if (interruptedSignal) {
    process.stderr.write(
      `[eliza-scenarios] stopped after ${reports.length}/${loaded.length} completed scenario(s) because ${interruptedSignal} was received; checkpoint evidence reflects exactly the completed scenarios.\n`,
    );
    return 1;
  }
  if (qualificationFailure) {
    process.stderr.write(
      `[eliza-scenarios] ${qualificationFailure}; native export is withheld and the run is nonpublishable.\n`,
    );
    return 1;
  }

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

/**
 * Process boundary shared by direct `src/cli.ts` execution and the published
 * `bin/eliza-scenarios` shim: runs the CLI and translates the result (or any
 * thrown failure) into an exit code. Kept separate from `runCli` so tests can
 * drive the CLI in-process without process.exit.
 */
export function runCliAndExit(
  argv: readonly string[] = process.argv.slice(2),
): void {
  captureHostExecutionBaseline();
  runCli(argv)
    .then((code) => {
      process.exit(code);
    })
    // error-policy:J1 CLI boundary translates thrown failures to exit codes.
    .catch((err: unknown) => {
      if (err instanceof CliUsageError) {
        process.stderr.write(formatUsageError(err));
        process.exit(err.exitCode);
      }
      process.stderr.write(
        `[eliza-scenarios] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCliAndExit();
}

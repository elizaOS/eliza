#!/usr/bin/env node
/**
 * Runs credentialed scenario catalogs through the shared runner with enforced
 * live-test, skip, and judge gates. It standardizes report and trajectory paths
 * and emits native JSONL evidence by default.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** A caller configuration error that maps to the wrapper's stable exit code. */
export class LiveScenarioConfigurationError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "LiveScenarioConfigurationError";
    this.exitCode = exitCode;
  }
}

/**
 * Resolve the child invocation without spawning it. Dependency injection keeps
 * the workflow contract executable in unit coverage without credentialed model
 * calls or writes outside a temporary directory.
 */
export function createLiveScenarioPlan(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const pathExists = options.existsSync ?? existsSync;
  const makeDirectory = options.mkdirSync ?? mkdirSync;
  const scenarioCli = path.join(
    repoRoot,
    "packages",
    "scenario-runner",
    "src",
    "cli.ts",
  );

  if (!pathExists(scenarioCli)) {
    throw new LiveScenarioConfigurationError(
      `[run-live-scenarios] scenario-runner CLI missing at ${scenarioCli}.`,
    );
  }
  if (env.ELIZA_LIVE_TEST !== "1") {
    throw new LiveScenarioConfigurationError(
      "[run-live-scenarios] refusing to run: ELIZA_LIVE_TEST=1 is required.",
    );
  }

  const skipFilter = (env.SCENARIO_SKIP ?? "").trim();
  const skipReason = (env.SKIP_REASON ?? "").trim();
  if (skipFilter.length > 0 && skipReason.length === 0) {
    throw new LiveScenarioConfigurationError(
      `[run-live-scenarios] SCENARIO_SKIP="${skipFilter}" requires SKIP_REASON to document why. Set SKIP_REASON="<concrete reason>" to acknowledge.`,
    );
  }

  const scenarioRootInput = (env.SCENARIO_ROOT ?? "").trim();
  const scenarioRoot =
    scenarioRootInput.length > 0
      ? path.resolve(repoRoot, scenarioRootInput)
      : path.join(repoRoot, "packages", "test", "scenarios");
  const reportPath =
    env.REPORT_PATH ??
    path.join(repoRoot, "artifacts", "lifeops-scenario-report.json");
  makeDirectory(path.dirname(reportPath), { recursive: true });
  const runDir =
    env.RUN_DIR ?? path.join(repoRoot, "artifacts", "scenario-runs", "live");
  makeDirectory(runDir, { recursive: true });

  const args = [
    "--import",
    "tsx",
    scenarioCli,
    "run",
    scenarioRoot,
    "--report",
    reportPath,
    "--run-dir",
    runDir,
  ];
  const exportNativePath = (
    env.EXPORT_NATIVE_PATH ?? path.join(runDir, "native.jsonl")
  ).trim();
  if (exportNativePath.length > 0) {
    makeDirectory(path.dirname(path.resolve(repoRoot, exportNativePath)), {
      recursive: true,
    });
    args.push("--export-native", exportNativePath);
  }
  args.push(...argv);
  const filter = (env.SCENARIO_FILTER ?? "").trim();
  if (filter.length > 0) args.push("--scenario", filter);

  const judgeThreshold = env.LIFEOPS_JUDGE_THRESHOLD ?? "0.8";
  const enforceGateValue = (env.SCENARIO_ENFORCE_GATE ?? "1")
    .trim()
    .toLowerCase();
  const enforceGate = !["0", "false", "no", "off"].includes(enforceGateValue);
  const childEnv = {
    ...env,
    ELIZA_LIVE_TEST: "1",
    LIFEOPS_LIVE_JUDGE_MIN_SCORE: judgeThreshold,
  };
  const independentJudge = Boolean(
    (env.CEREBRAS_API_KEY ?? "").trim() ||
      (env.EVAL_CEREBRAS_API_KEY ?? "").trim(),
  );
  const requireIndependentJudge =
    (env.SCENARIO_JUDGE_REQUIRE_INDEPENDENT ?? "").trim() === "1";

  return {
    repoRoot,
    args,
    childEnv,
    runDir,
    reportPath,
    skipFilter,
    skipReason,
    judgeThreshold,
    enforceGate,
    independentJudge,
    requireIndependentJudge,
  };
}

/** Spawn one resolved plan and translate the child boundary into an exit code. */
export async function runLiveScenarioPlan(plan, options = {}) {
  const spawnChild = options.spawnImpl ?? spawn;
  const logger = options.logger ?? console;
  const execPath = options.execPath ?? process.execPath;

  if (plan.skipReason.length > 0) {
    logger.warn(
      `[run-live-scenarios] SKIP_REASON acknowledged: "${plan.skipReason}" (filter="${plan.skipFilter}")`,
    );
  }
  logger.log(
    `[run-live-scenarios] threshold=${plan.judgeThreshold} enforce=${plan.enforceGate ? "yes" : "no"} pending=${plan.childEnv.SCENARIO_INCLUDE_PENDING === "1" ? "included" : "excluded"} judge=${plan.independentJudge ? "independent (cerebras)" : "SELF-GRADED (model under test — set CEREBRAS_API_KEY)"} requireIndependentJudge=${plan.requireIndependentJudge ? "yes" : "no"} report=${plan.reportPath} runDir=${plan.runDir} args=${plan.args.slice(2).join(" ")}`,
  );
  if (!plan.independentJudge && !plan.requireIndependentJudge) {
    logger.warn(
      "[run-live-scenarios] WARNING: no independent judge credentials — every judgeRubric/responseJudge score will be self-graded by the model under test (#9310).",
    );
  }

  return await new Promise((resolve, reject) => {
    const child = spawnChild(execPath, plan.args, {
      cwd: plan.repoRoot,
      env: plan.childEnv,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        logger.error(`[run-live-scenarios] killed by signal ${signal}`);
        resolve(1);
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !plan.enforceGate) {
        logger.warn(
          `[run-live-scenarios] scenario gate exited ${exitCode}; SCENARIO_ENFORCE_GATE=0 so the report is non-blocking.`,
        );
        resolve(0);
        return;
      }
      resolve(exitCode);
    });
  });
}

/** Outermost process boundary used by the workflow and direct CLI callers. */
export async function main(options = {}) {
  const logger = options.logger ?? console;
  try {
    const plan = createLiveScenarioPlan(options);
    return await runLiveScenarioPlan(plan, options);
  } catch (error) {
    // error-policy:J1 the executable boundary maps configuration/spawn failures
    // to stable non-zero process results while preserving the diagnostic.
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      error instanceof LiveScenarioConfigurationError
        ? message
        : `[run-live-scenarios] failed: ${message}`,
    );
    return error instanceof LiveScenarioConfigurationError ? error.exitCode : 1;
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) process.exitCode = await main();

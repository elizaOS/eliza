/**
 * Runs the live-information scenario against the declared planner matrix and
 * retains one self-contained evidence directory per backend. Provider secrets
 * stay in their existing environment or CLI credential stores and are never
 * copied into the matrix summary.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const scenarioCli = path.join(repoRoot, "packages/scenario-runner/src/cli.ts");
const scenarioDir = path.join(repoRoot, "packages/test/scenarios");
const scenarioId = "cross.live-information-routing";

export const LIVE_INFORMATION_MATRIX = [
  {
    id: "openai-cloud-mini",
    provider: "openai",
    model: "gpt-5.4-mini",
    purpose: "weaker hosted planner regression target",
    env: {
      OPENAI_SMALL_MODEL: "gpt-5.4-mini",
      OPENAI_LARGE_MODEL: "gpt-5.4-mini",
      SMALL_MODEL: "gpt-5.4-mini",
      LARGE_MODEL: "gpt-5.4-mini",
    },
  },
  {
    id: "codex-sol",
    provider: "cli",
    model: "gpt-5.6-sol",
    purpose: "current Codex planner",
    env: {
      ELIZA_CHAT_VIA_CLI: "codex",
      ELIZA_CLI_CODEX_MODEL: "gpt-5.6-sol",
      ELIZA_CLI_CODEX_PLANNER_MODEL: "gpt-5.6-sol",
      ELIZA_PLANNER_NATIVE_TOOLS: "0",
    },
  },
  {
    id: "claude-sonnet",
    provider: "cli",
    model: "claude-sonnet-4-6",
    purpose: "cross-family subscription planner",
    env: {
      ELIZA_CHAT_VIA_CLI: "claude",
      ELIZA_CLI_CLAUDE_MODEL: "claude-sonnet-4-6",
      ELIZA_CLI_CLAUDE_PLANNER_MODEL: "claude-sonnet-4-6",
      ELIZA_PLANNER_NATIVE_TOOLS: "0",
    },
  },
];

function parseArguments(argv) {
  let outputDir;
  const targetIds = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      outputDir = argv[index + 1];
      if (!outputDir) throw new Error("--output requires a directory");
      index += 1;
    } else if (argument === "--target") {
      const target = argv[index + 1];
      if (!target) throw new Error("--target requires a matrix target id");
      targetIds.push(target);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  const unknown = targetIds.filter(
    (id) => !LIVE_INFORMATION_MATRIX.some((target) => target.id === id),
  );
  if (unknown.length > 0) {
    throw new Error(`unknown matrix target(s): ${unknown.join(", ")}`);
  }
  const selected =
    targetIds.length === 0
      ? LIVE_INFORMATION_MATRIX
      : LIVE_INFORMATION_MATRIX.filter((target) =>
          targetIds.includes(target.id),
        );
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return {
    selected,
    outputDir: path.resolve(
      outputDir ?? path.join(repoRoot, "evidence/live-information", timestamp),
    ),
  };
}

function childEnvironment(target) {
  for (const name of [
    "SCENARIO_USE_DETERMINISTIC_MODEL",
    "ELIZA_SCENARIO_USE_DETERMINISTIC_MODEL",
  ]) {
    if (/^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? "")) {
      throw new Error(`${name} cannot be enabled for the live planner matrix`);
    }
  }
  const env = {
    ...process.env,
    ...target.env,
    ELIZA_INLINE_WEB_SEARCH: "1",
    ELIZA_WEB_FETCH: "1",
    SCENARIO_TURN_TIMEOUT_MS:
      process.env.SCENARIO_TURN_TIMEOUT_MS?.trim() || "300000",
    LIFEOPS_LIVE_JUDGE_MIN_SCORE:
      process.env.LIFEOPS_LIVE_JUDGE_MIN_SCORE?.trim() || "0.8",
  };
  if (target.provider !== "cli") {
    delete env.ELIZA_CHAT_VIA_CLI;
  }
  return env;
}

function runTarget(target, outputDir) {
  const targetDir = path.join(outputDir, target.id);
  const runDir = path.join(targetDir, "run");
  const reportDir = path.join(targetDir, "report");
  const nativePath = path.join(targetDir, "native.jsonl");
  const backendLog = path.join(targetDir, "backend.log");
  mkdirSync(targetDir, { recursive: true });

  const args = [
    "--conditions",
    "eliza-source",
    "--tsconfig-override",
    path.join(repoRoot, "tsconfig.json"),
    scenarioCli,
    "run",
    scenarioDir,
    "--scenario",
    scenarioId,
    "--lane",
    "live-only",
    "--provider",
    target.provider,
    "--run-dir",
    runDir,
    "--report-dir",
    reportDir,
    "--export-native",
    nativePath,
  ];
  process.stdout.write(
    `[live-information] running ${target.id} (${target.model}; ${target.purpose})\n`,
  );
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: childEnvironment(target),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  writeFileSync(
    backendLog,
    [`# stdout`, stdout, `# stderr`, stderr].join("\n"),
    "utf8",
  );
  return {
    id: target.id,
    provider: target.provider,
    model: target.model,
    purpose: target.purpose,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    artifacts: {
      backendLog: path.relative(outputDir, backendLog),
      runDir: path.relative(outputDir, runDir),
      reportDir: path.relative(outputDir, reportDir),
      nativeJsonl: path.relative(outputDir, nativePath),
    },
  };
}

const { selected, outputDir } = parseArguments(process.argv.slice(2));
mkdirSync(outputDir, { recursive: true });
const startedAt = new Date().toISOString();
const results = selected.map((target) => runTarget(target, outputDir));
const summary = {
  schemaVersion: 1,
  scenarioId,
  startedAt,
  completedAt: new Date().toISOString(),
  results,
};
writeFileSync(
  path.join(outputDir, "matrix-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`[live-information] evidence: ${outputDir}\n`);
if (results.some((result) => result.exitCode !== 0 || result.error)) {
  process.exitCode = 1;
}

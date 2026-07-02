#!/usr/bin/env node
/**
 * gpt-5.5 trajectory-training pipeline — Stage 2 harvest driver.
 *
 * Given the Stage-2 manifest (build-manifest.mjs) and the Stage-1 provider
 * incantation, iterate the corpus and run each item, capturing its
 * eliza_native_v1 trajectory + pass/fail verdict into a single harvest tree:
 *
 *   <harvestRoot>/<family>/<item>/
 *       report.json      scenario aggregate report (per-scenario status)
 *       native.jsonl     eliza_native_v1 model-boundary rows (scenarioStatus+judgeScore)
 *       native.jsonl.manifest.json
 *       verdict.json     { item, status: "passed"|"failed"|"skipped"|"error", rows, judgeScore }
 *       run/             per-turn RecordedTrajectory JSON (<run>/trajectories/**)
 *       stdout.log / stderr.log
 *
 * PROVIDER PARAMETERIZATION (consumes Stage-1 output):
 *   The provider env is injected, never hard-coded. Precedence:
 *     1. --provider-env <file.json>  (a JSON object of env vars; what S1 writes)
 *     2. $HARVEST_PROVIDER_ENV_FILE  (same, via env)
 *     3. current process env if it already carries ELIZA_CHAT_VIA_CLI / an API key
 *     4. --deterministic  → SCENARIO_USE_LLM_PROXY=1 (offline driver self-test)
 *   For the real Stage-2 run, S1 emits { "ELIZA_CHAT_VIA_CLI": "codex",
 *   "ELIZA_CLI_CODEX_MODEL": "gpt-5.5" }.
 *
 * This driver is SCOPED to the scenario family (the only family that emits
 * eliza_native_v1 natively). Benchmark + e2e families require the trajectory
 * wiring noted in the manifest and are enumerated but not executed here.
 *
 * Usage:
 *   node harvest-runner.mjs --provider-env s1-provider.json [--family scenario]
 *       [--dir <manifest.dir>] [--limit N] [--harvest-root <dir>] [--dry-run]
 *   node harvest-runner.mjs --deterministic --limit 3 --dry-run   # driver self-test
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function flag(name) {
  return process.argv.includes(name);
}
function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DRY_RUN = flag("--dry-run");
const DETERMINISTIC = flag("--deterministic");
const LIMIT = Number(opt("--limit", "0")) || 0; // 0 = no limit
const FAMILY = opt("--family", "scenario");
const DIR_FILTER = opt("--dir", null);
const MANIFEST_PATH = opt("--manifest", path.join(__dirname, "manifest.json"));
const HARVEST_ROOT = path.resolve(
  opt(
    "--harvest-root",
    path.join(
      REPO_ROOT,
      ".github/issue-evidence/gpt55-training-pipeline/harvest",
    ),
  ),
);
const TSCONFIG = path.join(REPO_ROOT, "tsconfig.json");
const SCENARIO_TIMEOUT_MS = Number(opt("--item-timeout-ms", "300000")) || 300000;

/** Load the provider env object per the precedence documented above. */
function loadProviderEnv() {
  const file = opt("--provider-env", process.env.HARVEST_PROVIDER_ENV_FILE);
  if (file && existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { source: `file:${file}`, env: parsed };
  }
  if (DETERMINISTIC) {
    return {
      source: "deterministic-proxy",
      env: { SCENARIO_USE_LLM_PROXY: "1" },
    };
  }
  if (process.env.ELIZA_CHAT_VIA_CLI) {
    return {
      source: "inherited:ELIZA_CHAT_VIA_CLI",
      env: {
        ELIZA_CHAT_VIA_CLI: process.env.ELIZA_CHAT_VIA_CLI,
        ...(process.env.ELIZA_CLI_CODEX_MODEL
          ? { ELIZA_CLI_CODEX_MODEL: process.env.ELIZA_CLI_CODEX_MODEL }
          : {}),
      },
    };
  }
  const apiKeys = [
    "OPENAI_API_KEY",
    "GROQ_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "OPENROUTER_API_KEY",
    "CEREBRAS_API_KEY",
  ].filter((k) => process.env[k]);
  if (apiKeys.length > 0) {
    return { source: `inherited:${apiKeys[0]}`, env: {} };
  }
  throw new Error(
    "no provider configured: pass --provider-env <s1.json>, --deterministic, or export ELIZA_CHAT_VIA_CLI / an API key",
  );
}

/** Enumerate concrete scenario ids under a manifest scenario dir via `list`. */
function discoverScenarioIds(dirRel, providerEnv) {
  const args = [
    "--conditions",
    "eliza-source",
    "--tsconfig-override",
    TSCONFIG,
    path.join(REPO_ROOT, "packages/scenario-runner/src/cli.ts"),
    "list",
    dirRel,
  ];
  const res = spawnSync("bun", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 240000,
    env: { ...process.env, ...providerEnv },
  });
  const ids = [];
  for (const line of (res.stdout || "").split("\n")) {
    const t = line.trim();
    // list prints bare scenario ids, one per line (plus a leading info log line).
    if (t && !t.includes(" ") && !t.startsWith("[") && !t.startsWith("{"))
      ids.push(t);
  }
  return [...new Set(ids)];
}

/** Run one scenario id, capturing report + native jsonl + verdict. */
function runScenario(dirRel, id, providerEnv) {
  const itemDir = path.join(HARVEST_ROOT, "scenario", slug(dirRel), slug(id));
  mkdirSync(itemDir, { recursive: true });
  const reportPath = path.join(itemDir, "report.json");
  const runDir = path.join(itemDir, "run");
  const nativePath = path.join(itemDir, "native.jsonl");
  const args = [
    "--conditions",
    "eliza-source",
    "--tsconfig-override",
    TSCONFIG,
    path.join(REPO_ROOT, "packages/scenario-runner/src/cli.ts"),
    "run",
    dirRel,
    "--scenario",
    id,
    "--report",
    reportPath,
    "--run-dir",
    runDir,
    "--export-native",
    nativePath,
  ];
  const res = spawnSync("bun", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: SCENARIO_TIMEOUT_MS,
    env: { ...process.env, ...providerEnv, ELIZA_SAVE_TRAJECTORIES: "1" },
  });
  writeFileSync(path.join(itemDir, "stdout.log"), res.stdout || "");
  writeFileSync(path.join(itemDir, "stderr.log"), res.stderr || "");

  const verdict = {
    item: id,
    dir: dirRel,
    exitCode: res.status,
    status: "error",
    rows: 0,
    judgeScore: null,
    reportPath: existsSync(reportPath) ? reportPath : null,
    nativePath: existsSync(nativePath) ? nativePath : null,
  };
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      const sc = (report.scenarios || []).find((x) => x.id === id) || report.scenarios?.[0];
      if (sc) {
        verdict.status = sc.status || "error";
        if (typeof sc.judgeScore === "number") verdict.judgeScore = sc.judgeScore;
      }
    } catch {
      /* leave status=error; stderr.log holds detail */
    }
  }
  if (existsSync(nativePath)) {
    verdict.rows = readFileSync(nativePath, "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;
  }
  writeFileSync(
    path.join(itemDir, "verdict.json"),
    JSON.stringify(verdict, null, 2),
  );
  return verdict;
}

function slug(s) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const provider = loadProviderEnv();
  mkdirSync(HARVEST_ROOT, { recursive: true });
  const summary = {
    startedAt: new Date().toISOString(),
    manifest: MANIFEST_PATH,
    harvestRoot: HARVEST_ROOT,
    family: FAMILY,
    providerSource: provider.source,
    providerEnvKeys: Object.keys(provider.env),
    dryRun: DRY_RUN,
    limit: LIMIT,
    items: [],
  };

  if (FAMILY !== "scenario") {
    summary.note = `family '${FAMILY}' requires trajectory wiring (see manifest.families.${FAMILY}.trajectoryWiring); driver executes the scenario family only in Stage 1.`;
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const dirs = manifest.families.scenario.items.filter(
    (it) => !DIR_FILTER || it.dir === DIR_FILTER || it.id === DIR_FILTER,
  );

  let ran = 0;
  outer: for (const dirItem of dirs) {
    const ids = discoverScenarioIds(dirItem.dir, provider.env);
    for (const id of ids) {
      if (LIMIT && ran >= LIMIT) break outer;
      ran += 1;
      if (DRY_RUN) {
        summary.items.push({ dir: dirItem.dir, id, planned: true });
        console.log(`[dry-run] would harvest scenario ${dirItem.dir} :: ${id}`);
        continue;
      }
      console.log(`[harvest] ${dirItem.dir} :: ${id}`);
      const verdict = runScenario(dirItem.dir, id, provider.env);
      summary.items.push(verdict);
      console.log(
        `[harvest]   → status=${verdict.status} rows=${verdict.rows} judge=${verdict.judgeScore ?? "n/a"} exit=${verdict.exitCode}`,
      );
    }
  }

  summary.finishedAt = new Date().toISOString();
  summary.count = summary.items.length;
  const summaryPath = path.join(
    HARVEST_ROOT,
    `harvest-summary-${DRY_RUN ? "dryrun" : "run"}-${Date.now()}.json`,
  );
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\nsummary → ${summaryPath}`);
  console.log(
    `items=${summary.count} provider=${provider.source} dryRun=${DRY_RUN}`,
  );
}

main();

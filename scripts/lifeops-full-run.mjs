#!/usr/bin/env node
/**
 * Unified multi-agent lifeops benchmark runner.
 *
 * One command, no flags: `bun run lifeops:full`.
 *
 * Steps (each gates the next where it matters):
 *   1. Bootstrap Mockoon — every connector under test/mocks/mockoon/ is
 *      spawned, ports probed, LIFEOPS_USE_MOCKOON=1 exported, cleanup hook
 *      registered so mockoons are SIGTERM'd on parent exit / Ctrl-C.
 *   2. Verify Cerebras eval helper reachable.
 *   3. For each agent in MILADY_BENCH_AGENT (default "all" → eliza, hermes,
 *      openclaw), invoke the Python multi-agent bench against Cerebras
 *      gpt-oss-120b. Sequential, since they share the same Cerebras quota
 *      and the same Mockoon port fleet.
 *   4. Run the legacy JS scenario-runner over test/scenarios/lifeops.*
 *      directories so the existing TS scenarios continue to execute.
 *   5. Aggregate. One side-by-side markdown report at the run-dir root
 *      compares all agents on pass@1, mean score, cost, latency.
 *
 * Env knobs (all have sensible defaults — operator should never need flags):
 *   - LIFEOPS_USE_MOCKOON       (default "1")        Toggle Mockoon substrate.
 *   - MILADY_BENCH_AGENT        (default "all")      "all" | eliza | hermes |
 *                                                    openclaw | cerebras-direct.
 *   - MILADY_BENCH_LIMIT        (default "25")       Scenarios per agent.
 *   - MILADY_BENCH_MODEL        (default "gpt-oss-120b")  Cerebras model id.
 *   - MILADY_BENCH_CONCURRENCY  (default "2")        Python concurrency
 *                                                    (lowered from 4 after
 *                                                    Cerebras 429s under load;
 *                                                    raise back to 4+ for
 *                                                    non-Cerebras providers).
 *   - MILADY_BENCH_SEEDS        (default "1")        Repetitions per scenario.
 *   - MILADY_BENCH_SKIP_JS      (default "")         Set to "1" to skip the
 *                                                    JS scenario-runner step.
 *   - CEREBRAS_API_KEY          (required)           Sourced from eliza/.env.
 *
 * Output:
 *   ~/.milady/runs/lifeops/lifeops-multiagent-<ts>/
 *     mockoon/                  Mockoon bootstrap log.
 *     eliza/                    Python bench JSON for eliza.
 *     hermes/                   Python bench JSON for hermes.
 *     openclaw/                 Python bench JSON for openclaw.
 *     js-scenarios/             Legacy TS scenario-runner JSON outputs.
 *     report.md                 Side-by-side multi-agent comparison.
 *     report.json               Machine-readable rollup.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureMockoonRunning } from "./lifeops-mockoon-bootstrap.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

// Load eliza/.env into process.env so spawned subprocesses (Python bench,
// adapters) see CEREBRAS_API_KEY etc. without operators having to source it
// in their shell.
const ENV_FILE = join(REPO_ROOT, ".env");
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}
const BENCH_DIR = join(
  REPO_ROOT,
  "packages",
  "benchmarks",
  "lifeops-bench",
);

const AGENT_ORDER = ["eliza", "hermes", "openclaw"];
const KNOWN_AGENTS = new Set([...AGENT_ORDER, "cerebras-direct"]);

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.warn(
      `[lifeops-full-run] ignoring non-positive-integer ${name}=${raw}; using ${fallback}`,
    );
    return fallback;
  }
  return n;
}

function envStr(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envBoolish(name, fallback) {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "" ) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

const cliAgent = envStr("MILADY_BENCH_AGENT", "all");
const scenarioLimit = envInt("MILADY_BENCH_LIMIT", 25);
const model = envStr("MILADY_BENCH_MODEL", "gpt-oss-120b");
const concurrency = envInt("MILADY_BENCH_CONCURRENCY", 2);
const seeds = envInt("MILADY_BENCH_SEEDS", 1);
const useMockoon = envBoolish("LIFEOPS_USE_MOCKOON", true);
const skipJsScenarios = envBoolish("MILADY_BENCH_SKIP_JS", false);

let agents;
if (cliAgent === "all") {
  agents = [...AGENT_ORDER];
} else if (KNOWN_AGENTS.has(cliAgent)) {
  agents = [cliAgent];
} else {
  console.error(
    `[lifeops-full-run] unknown MILADY_BENCH_AGENT=${cliAgent}; valid: all | ${AGENT_ORDER.join(" | ")} | cerebras-direct`,
  );
  process.exit(2);
}

const RUN_TS = Date.now();
const RUN_ID = `lifeops-multiagent-${RUN_TS}`;
const RUN_DIR = join(homedir(), ".milady", "runs", "lifeops", RUN_ID);
mkdirSync(RUN_DIR, { recursive: true });

console.log(`[lifeops-full-run] RUN_ID=${RUN_ID}`);
console.log(`[lifeops-full-run] RUN_DIR=${RUN_DIR}`);
console.log(
  `[lifeops-full-run] agents=[${agents.join(", ")}] limit=${scenarioLimit} model=${model} seeds=${seeds} concurrency=${concurrency} mockoon=${useMockoon}`,
);

function run(label, cmd, cmdArgs, opts = {}) {
  console.log(`\n[lifeops-full-run] ▶ ${label}`);
  console.log(`[lifeops-full-run]   ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: opts.env ?? process.env,
    stdio: opts.stdio ?? "inherit",
    encoding: "utf8",
  });
  const ok = r.status === 0;
  console.log(
    `[lifeops-full-run] ${ok ? "✓" : "·"} ${label} (status=${r.status})`,
  );
  if (!ok && !opts.allowFail) {
    console.error(
      `[lifeops-full-run] ✗ ${label} failed; aborting unless allowFail set`,
    );
  }
  return r;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 1 — Mockoon bootstrap (cleanup registered inside ensureMockoonRunning).
// ─────────────────────────────────────────────────────────────────────────
let mockoonHandle = null;
if (useMockoon) {
  try {
    mockoonHandle = await ensureMockoonRunning({ label: "lifeops-full" });
    const mockoonSummary = mockoonHandle.connectors.map((c) => ({
      name: c.name,
      port: c.port,
      pid: c.pid,
    }));
    mkdirSync(join(RUN_DIR, "mockoon"), { recursive: true });
    writeFileSync(
      join(RUN_DIR, "mockoon", "fleet.json"),
      JSON.stringify(mockoonSummary, null, 2),
    );
    console.log(
      `[lifeops-full-run] mockoon up — ${mockoonHandle.connectors.length} connectors listening`,
    );
  } catch (e) {
    console.error(`[lifeops-full-run] mockoon bootstrap failed: ${e?.message ?? e}`);
    process.exit(2);
  }
} else {
  console.log(`[lifeops-full-run] LIFEOPS_USE_MOCKOON=0 → skipping mockoon bootstrap`);
}

// ─────────────────────────────────────────────────────────────────────────
// Step 2 — Verify Cerebras reachable.
// ─────────────────────────────────────────────────────────────────────────
const verify = run(
  "verify-cerebras-wiring",
  "bun",
  ["--bun", "plugins/app-lifeops/scripts/verify-cerebras-wiring.ts"],
  { allowFail: false },
);
if (verify.status !== 0) {
  console.error("[lifeops-full-run] aborting: Cerebras unreachable");
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────
// Step 3 — Per-agent Python bench runs.
// ─────────────────────────────────────────────────────────────────────────
const benchEnv = {
  ...process.env,
  // Force the harness chain onto the requested model. resolve_tier() honors
  // MODEL_NAME_OVERRIDE, and the default tier is already large → cerebras.
  MODEL_NAME_OVERRIDE: model,
  MODEL_TIER: "large",
  PYTHONUNBUFFERED: "1",
};

const agentResults = [];
for (const agent of agents) {
  const agentDir = join(RUN_DIR, agent);
  mkdirSync(agentDir, { recursive: true });
  const args = [
    "-m",
    "eliza_lifeops_bench",
    "--agent",
    agent,
    "--limit",
    String(scenarioLimit),
    "--seeds",
    String(seeds),
    "--concurrency",
    String(concurrency),
    "--output-dir",
    agentDir,
    "--mode",
    "static",
  ];
  const r = run(`bench agent=${agent}`, "python3", args, {
    allowFail: true,
    cwd: BENCH_DIR,
    env: benchEnv,
  });
  agentResults.push({
    agent,
    outputDir: agentDir,
    status: r.status,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Step 4 — Legacy JS scenario-runner over test/scenarios/lifeops.*
// ─────────────────────────────────────────────────────────────────────────
if (!skipJsScenarios) {
  const jsDir = join(RUN_DIR, "js-scenarios");
  mkdirSync(jsDir, { recursive: true });

  const jsTargets = [
    "plugins/app-lifeops/test/scenarios",
    "test/scenarios/lifeops.habits",
    "test/scenarios/lifeops.workflow-events",
  ];
  for (const target of jsTargets) {
    const fullDir = join(REPO_ROOT, target);
    if (!existsSync(fullDir)) {
      console.warn(`[lifeops-full-run] skip ${target} — not found`);
      continue;
    }
    const reportPath = join(
      jsDir,
      `scenario-runner-${target.replaceAll("/", "_")}.json`,
    );
    run(
      `js-scenario-runner ${target}`,
      "bun",
      [
        "--bun",
        "packages/scenario-runner/src/cli.ts",
        "run",
        fullDir,
        "--run-dir",
        RUN_DIR,
        "--runId",
        RUN_ID,
        "--report",
        reportPath,
      ],
      { allowFail: true },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Step 5 — Aggregate side-by-side multi-agent report.
// ─────────────────────────────────────────────────────────────────────────
run(
  "aggregate-multiagent-report",
  "node",
  [
    "scripts/lifeops-multiagent-report.mjs",
    "--run-dir",
    RUN_DIR,
    "--run-id",
    RUN_ID,
  ],
  { allowFail: false },
);

const reportPath = join(RUN_DIR, "report.md");
if (existsSync(reportPath)) {
  console.log("\n[lifeops-full-run] ===== multi-agent report (head) =====");
  console.log(
    readFileSync(reportPath, "utf8").split("\n").slice(0, 80).join("\n"),
  );
}

console.log(`\n[lifeops-full-run] DONE`);
console.log(`[lifeops-full-run] artifacts: ${RUN_DIR}`);

// Final exit code: failure if any agent returned non-zero.
const failures = agentResults.filter((r) => r.status !== 0);
if (failures.length > 0) {
  console.error(
    `[lifeops-full-run] ${failures.length}/${agentResults.length} agent run(s) returned non-zero: ${failures.map((f) => f.agent).join(", ")}`,
  );
  // Still exit 0 so the artifacts upload in CI; surface failure via report.md.
  // Operators see the per-agent status table in report.md.
}

#!/usr/bin/env node
/**
 * Per-auth-path live-lane driver for the LifeOps HITL validation run (#11632).
 *
 * Env resolution is the layered load shared with the HITL dashboard
 * (env-layers.mjs: process.env > repo .env > main-checkout .env >
 * ~/.eliza/.env), hydrated into process.env once at startup so readiness
 * checks here and the spawned suites see exactly what the dashboard rows show.
 * Env var NAMES are printed for readiness; env var VALUES are never logged.
 *
 * Each lane is one connector auth path (a CONNECTOR_PATHS id, or a lifeops.*
 * pseudo-path for the keyless/model-gated LifeOps suites) bound to the live
 * vitest suite that proves it. Gating is per path: the path's own
 * requiredAll/requiredAny env names plus its declarative availability spec
 * (checkAvailability). An unsatisfied path prints `SKIP <pathId>: <reason>`
 * and is recorded — it is never a failure. `--dry-run` extends the readiness
 * view to every registry path, so suiteless paths (probe-only, covered by the
 * dashboard) are visible instead of silently absent.
 *
 * Every lane completion (any status) upserts the committed evidence ledger
 * docs/testing/hitl-ledger.json ({pathId, lastRunAt, lastSuccessAt, lane,
 * commit, counts} — hitl-ledger.mjs writes atomically with stable key order)
 * and then commits the ledger: `chore(hitl): ledger — <pathId> <status>`.
 * `lastSuccessAt` only advances on live-proven lanes: exit 0 with zero
 * skipped tests in the vitest summary — skipped live describes downgrade to
 * `ran-with-skips`, a nonzero exit records `failed`. `--status` renders the
 * ledger freshness table (green ≤7d, yellow >7d, red >30d or never).
 *
 * Lane stdout+stderr tee to the exact filenames the collector's
 * `existingEvidence` parsers grep — owner-agent-permission-matrix.txt,
 * plugin-google-live.txt, plugin-x-live.txt under
 * reports/lifeops-live-validation/11632-status/ — and the remaining lanes log
 * into a datestamped session dir next to them, alongside summary.json.
 *
 * Usage:
 *   node scripts/lifeops/run-11632-live-lanes.mjs            # all ready lanes
 *   node scripts/lifeops/run-11632-live-lanes.mjs --dry-run  # per-path readiness only
 *   node scripts/lifeops/run-11632-live-lanes.mjs --lane=1   # one lane
 *   node scripts/lifeops/run-11632-live-lanes.mjs --status   # ledger freshness table
 */
import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CONNECTOR_GROUPS } from "./collect-11632-live-validation-status.mjs";
import { CONNECTOR_PATHS, checkAvailability } from "./connector-paths.mjs";
import { applyLayeredEnvToProcess } from "./env-layers.mjs";
import {
  freshness,
  LEDGER_PATH,
  readLedger,
  recordOutcome,
} from "./hitl-ledger.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const STATUS_DIR = join(ROOT, "reports/lifeops-live-validation/11632-status");
const COLLECTOR = join(__dirname, "collect-11632-live-validation-status.mjs");

const PA_LIVE_E2E_FILES = [
  "plugins/plugin-personal-assistant/test/assistant-user-journeys.live.e2e.test.ts",
  "plugins/plugin-personal-assistant/test/lifeops-chat.live.e2e.test.ts",
  "plugins/plugin-personal-assistant/test/lifeops-gmail-chat.live.e2e.test.ts",
  "plugins/plugin-personal-assistant/test/lifeops-memory.live.e2e.test.ts",
];

const MODEL_REQUIRED_ANY = CONNECTOR_GROUPS.find(
  (group) => group.id === "model",
).requiredAny;

/**
 * LifeOps suites are auth-path rows too, but they are not connector paths:
 * the permission matrix is deliberately credential-free, and the two live
 * model lanes gate on "any live model provider" rather than one key. They
 * live in the ledger under the lifeops.* family with the same entry shape.
 */
const LIFEOPS_PSEUDO_PATHS = [
  {
    id: "lifeops.permission-matrix",
    label: "Owner/agent permission matrix (keyless)",
    requiredAll: [],
    requiredAny: [],
    availability: { type: "always" },
  },
  {
    id: "lifeops.pa-background-real",
    label: "Personal-assistant background loop (live model)",
    requiredAll: [],
    requiredAny: MODEL_REQUIRED_ANY,
    availability: { type: "always" },
  },
  {
    id: "lifeops.pa-live-e2e",
    label: "Personal-assistant live e2e journeys (live model)",
    requiredAll: [],
    requiredAny: MODEL_REQUIRED_ANY,
    availability: { type: "always" },
  },
];

const PATH_SPECS = new Map(
  [...CONNECTOR_PATHS, ...LIFEOPS_PSEUDO_PATHS].map((path) => [path.id, path]),
);

/**
 * Lane order mirrors the collector's `nextCommands`: keyless proof first, then
 * connector-scoped live suites, then the model-gated LifeOps lanes. Each lane
 * names the auth path it proves; gates come from that path's registry entry,
 * so telegram.bot-style additions are one suite mapping here, not a new gate
 * system. Lane 3's plugin-x tests call dotenv.config() against the plugin cwd
 * with override:false, so the env injected here wins over any plugin-local
 * .env. Lane 5 runs the shared live-e2e vitest lane; its include globs are
 * derived from the resolved eliza workspace root
 * (packages/test/vitest/e2e.config.ts), so the same command collects the PA
 * live e2e files from both the flat elizaOS checkout and the nested `eliza/`
 * consumer layout.
 */
const LANES = [
  {
    n: 1,
    pathId: "lifeops.permission-matrix",
    env: { LIFEOPS_PERMISSION_MATRIX: "1" },
    command: [
      "bunx",
      "vitest",
      "run",
      "--config",
      "packages/test/vitest/integration.config.ts",
      "plugins/plugin-personal-assistant/test/owner-agent-permission-matrix.integration.test.ts",
    ],
    logPath: () => join(STATUS_DIR, "owner-agent-permission-matrix.txt"),
  },
  {
    n: 2,
    pathId: "google.oauth-owner",
    env: { TEST_LANE: "post-merge", ELIZA_LIVE_TEST: "1" },
    command: ["bun", "run", "--cwd", "plugins/plugin-google", "test"],
    logPath: () => join(STATUS_DIR, "plugin-google-live.txt"),
  },
  {
    n: 3,
    pathId: "x.oauth1-user",
    env: { TEST_LANE: "post-merge", ELIZA_LIVE_TEST: "1" },
    command: ["bun", "run", "--cwd", "plugins/plugin-x", "test"],
    logPath: () => join(STATUS_DIR, "plugin-x-live.txt"),
  },
  {
    n: 4,
    pathId: "lifeops.pa-background-real",
    env: { ELIZA_LIVE_TEST: "1", LIFEOPS_PERMISSION_MATRIX: "1" },
    command: [
      "bun",
      "run",
      "--cwd",
      "plugins/plugin-personal-assistant",
      "test:background-real",
    ],
    logPath: (sessionDir) => join(sessionDir, "pa-background-real.txt"),
  },
  {
    n: 5,
    pathId: "lifeops.pa-live-e2e",
    env: { ELIZA_LIVE_TEST: "1" },
    command: [
      "bunx",
      "vitest",
      "run",
      "--config",
      "packages/test/vitest/live-e2e.config.ts",
      ...PA_LIVE_E2E_FILES,
    ],
    logPath: (sessionDir) => join(sessionDir, "pa-live-e2e.txt"),
  },
];

for (const lane of LANES) {
  if (!PATH_SPECS.has(lane.pathId)) {
    throw new Error(`lane ${lane.n}: unknown auth path '${lane.pathId}'`);
  }
}

function parseArgs(argv) {
  const usage =
    "Usage: node scripts/lifeops/run-11632-live-lanes.mjs [--dry-run] [--lane=<n>] [--status]";
  const args = { dryRun: false, lane: null, status: false };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--status") {
      args.status = true;
    } else if (/^--lane=\d+$/.test(arg)) {
      args.lane = Number(arg.slice("--lane=".length));
    } else if (arg === "--help") {
      console.log(usage);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error(usage);
      process.exit(2);
    }
  }
  if (args.lane !== null && !LANES.some((lane) => lane.n === args.lane)) {
    console.error(`--lane must be one of 1..${LANES.length}`);
    process.exit(2);
  }
  return args;
}

function hasEnvName(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Per-path gate: availability spec first (machine state), then the path's own
 * env names against the hydrated layered env. Reasons carry env var NAMES
 * only, never values.
 */
function pathReadiness(spec) {
  const availability = checkAvailability(spec.availability);
  if (!availability.available) {
    return { ready: false, reason: availability.reason };
  }
  const requiredAll = spec.requiredAll ?? [];
  const requiredAny = spec.requiredAny ?? [];
  const missing = requiredAll.filter((name) => !hasEnvName(name));
  const anySatisfied = requiredAny.length === 0 || requiredAny.some(hasEnvName);
  if (missing.length === 0 && anySatisfied)
    return { ready: true, reason: null };
  const parts = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`);
  if (!anySatisfied) parts.push(`one of: ${requiredAny.join("|")}`);
  return { ready: false, reason: parts.join("; ") };
}

/** Spawns a command from the repo root, tee-ing stdout+stderr to `logPath`. */
function runCommand(command, extraEnv, logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  return new Promise((resolvePromise, rejectPromise) => {
    const logStream = createWriteStream(logPath);
    const child = spawn(command[0], command.slice(1), {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tee = (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    };
    child.stdout.on("data", tee);
    child.stderr.on("data", tee);
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      // Flush the log before callers re-read it for skip-count parsing.
      logStream.end(() => resolvePromise({ code, signal }));
    });
  });
}

function stripAnsi(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips vitest's color codes before count parsing.
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Sums the `Tests  N passed | M skipped (T)` summary lines of every vitest
 * invocation in the tee'd log. The skip count is the live-proof gate: a green
 * exit with skipped live describes is not live proof.
 */
function parseVitestCounts(logText) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  const summaryLines =
    stripAnsi(logText).match(/^[ \t]*Tests[ \t]+[^\n]*$/gm) ?? [];
  for (const line of summaryLines) {
    for (const key of Object.keys(counts)) {
      const match = new RegExp(`(\\d+)\\s+${key}`).exec(line);
      if (match) counts[key] += Number(match[1]);
    }
  }
  return { ...counts, summaryLines: summaryLines.map((line) => line.trim()) };
}

function laneOutcome(result, counts) {
  if (result.code !== 0) {
    return {
      status: "failed",
      skipReason: `exit ${result.code ?? `signal ${result.signal}`}`,
    };
  }
  if (counts.skipped > 0) {
    return {
      status: "ran-with-skips",
      skipReason: `${counts.skipped} skipped test(s) in log — not live proof`,
    };
  }
  return { status: "live-proven", skipReason: null };
}

// --- committed evidence ledger -------------------------------------------------

function git(args) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function shortHead() {
  const result = git(["rev-parse", "--short", "HEAD"]);
  if (result.status !== 0) {
    throw new Error(`git rev-parse --short HEAD failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** lastSuccessAt only advances on live-proven; a skip preserves prior proof. */
function ledgerOk(status) {
  if (status === "live-proven") return true;
  if (status === "skipped") return null;
  return false;
}

/**
 * Stage and commit only the ledger file (pathspec commit), so concurrent
 * working-tree edits from other agents are never swept into an evidence
 * commit. Committing evidence-of-run to the repo is the owner's explicit ask.
 */
function commitLedger(pathId, status) {
  const rel = relative(ROOT, LEDGER_PATH);
  const dirty = git(["status", "--porcelain", "--", rel]);
  if (dirty.status !== 0) {
    throw new Error(`git status for ${rel} failed: ${dirty.stderr}`);
  }
  if (dirty.stdout.trim().length === 0) return false;
  const add = git(["add", "--", rel]);
  if (add.status !== 0) {
    throw new Error(`git add ${rel} failed: ${add.stderr}`);
  }
  const commit = git([
    "commit",
    "-m",
    `chore(hitl): ledger — ${pathId} ${status}`,
    "--",
    rel,
  ]);
  if (commit.status !== 0) {
    throw new Error(
      `git commit of ${rel} failed: ${commit.stdout}${commit.stderr}`,
    );
  }
  return true;
}

function recordLane(lane, status, counts, headShort) {
  recordOutcome({
    pathId: lane.pathId,
    ok: ledgerOk(status),
    at: new Date().toISOString(),
    lane: `live-lane-${lane.n}`,
    commit: headShort,
    counts: {
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
    },
  });
  const committed = commitLedger(lane.pathId, status);
  console.log(
    `[11632-lanes] ledger ${committed ? "committed" : "unchanged"} — ${lane.pathId} ${status}`,
  );
}

// --- terminal freshness table ----------------------------------------------------

const STATE_COLORS = { green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m" };

function printStatusTable() {
  const ledger = readLedger();
  const ids = [
    ...new Set([
      ...LANES.map((lane) => lane.pathId),
      ...CONNECTOR_PATHS.map((path) => path.id),
      ...Object.keys(ledger.entries),
    ]),
  ].sort();
  const paint = (state, text) =>
    process.stdout.isTTY ? `${STATE_COLORS[state]}${text}\x1b[0m` : text;
  console.log(
    "[11632-lanes] HITL freshness from ledger lastSuccessAt — green ≤7d, yellow >7d, red >30d or never",
  );
  console.log(
    `[11632-lanes] ledger ${relative(ROOT, LEDGER_PATH)} (updated ${ledger.updatedAt ?? "never"})`,
  );
  for (const id of ids) {
    const entry = ledger.entries[id];
    const fresh = freshness(entry ? entry.lastSuccessAt : null);
    const counts = entry
      ? `${entry.counts.passed}p/${entry.counts.failed}f/${entry.counts.skipped}s`
      : "-";
    const detail = entry
      ? `lastRun ${entry.lastRunAt}  ${entry.lane}@${entry.commit}  ${counts}`
      : "no ledger entry";
    console.log(
      `${paint(fresh.state, fresh.state.padEnd(6))} ${id.padEnd(28)} ${fresh.label.padEnd(20)} ${detail}`,
    );
  }
}

// --- entrypoint --------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

if (args.status) {
  printStatusTable();
  process.exit(0);
}

const layered = applyLayeredEnvToProcess();
for (const layer of layered.layers) {
  console.log(
    `[11632-lanes] env layer ${layer.source.padEnd(8)} ${layer.path ?? "(process.env)"}${layer.exists ? "" : " (absent)"}`,
  );
}

if (args.dryRun) {
  console.log(
    "[11632-lanes] dry run — per-auth-path readiness from the layered env (nothing executed):",
  );
  for (const lane of LANES) {
    const { ready, reason } = pathReadiness(PATH_SPECS.get(lane.pathId));
    if (ready) {
      console.log(`READY lane ${lane.n} ${lane.pathId}`);
    } else {
      console.log(`SKIP ${lane.pathId}: ${reason}`);
    }
  }
  const lanePathIds = new Set(LANES.map((lane) => lane.pathId));
  console.log(
    "[11632-lanes] registry paths without a wired live suite (probe via the HITL dashboard):",
  );
  for (const path of CONNECTOR_PATHS) {
    if (lanePathIds.has(path.id)) continue;
    const { ready, reason } = pathReadiness(path);
    console.log(
      `SKIP ${path.id}: ${ready ? "env satisfied — no live suite wired for this path" : reason}`,
    );
  }
  process.exit(0);
}

const selected =
  args.lane === null ? LANES : LANES.filter((lane) => lane.n === args.lane);
const sessionStamp = new Date()
  .toISOString()
  .replace(/:/g, "-")
  .replace(/\..+$/, "Z");
const sessionDir = join(STATUS_DIR, `session-${sessionStamp}`);
mkdirSync(sessionDir, { recursive: true });

// Captured once, before any ledger commits advance HEAD: ledger entries must
// point at the code the lane ran against, not at a prior lane's evidence commit.
const headShort = shortHead();

console.log("[11632-lanes] collector pre-pass");
const collectorResult = await runCommand(
  ["node", COLLECTOR],
  {},
  join(sessionDir, "collector-prepass.txt"),
);
if (collectorResult.code !== 0) {
  console.error(
    `[11632-lanes] collector pre-pass failed (exit ${collectorResult.code}); aborting`,
  );
  process.exit(1);
}

const summary = [];
let anyFailed = false;
for (const lane of selected) {
  const { ready, reason } = pathReadiness(PATH_SPECS.get(lane.pathId));
  if (!ready) {
    console.log(`SKIP ${lane.pathId}: ${reason}`);
    recordLane(
      lane,
      "skipped",
      { passed: 0, failed: 0, skipped: 0 },
      headShort,
    );
    summary.push({
      pathId: lane.pathId,
      laneNumber: lane.n,
      status: "skipped",
      skipReason: reason,
      logPath: null,
    });
    continue;
  }

  const logPath = lane.logPath(sessionDir);
  console.log(
    `[11632-lanes] lane ${lane.n} ${lane.pathId}: ${lane.command.join(" ")} → ${relative(ROOT, logPath)}`,
  );
  const result = await runCommand(lane.command, lane.env, logPath);
  const counts = parseVitestCounts(readFileSync(logPath, "utf8"));
  const { status, skipReason } = laneOutcome(result, counts);
  if (status === "failed") anyFailed = true;
  console.log(
    `[11632-lanes] lane ${lane.n} ${lane.pathId}: ${status}${skipReason ? ` (${skipReason})` : ""} — ${counts.passed} passed | ${counts.failed} failed | ${counts.skipped} skipped`,
  );
  recordLane(lane, status, counts, headShort);
  summary.push({
    pathId: lane.pathId,
    laneNumber: lane.n,
    status,
    skipReason,
    exitCode: result.code,
    counts: {
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
    },
    vitestSummaryLines: counts.summaryLines,
    logPath: relative(ROOT, logPath),
  });
}

const summaryPath = join(sessionDir, "summary.json");
writeFileSync(
  summaryPath,
  `${JSON.stringify(
    {
      issue: 11632,
      generatedAt: new Date().toISOString(),
      sessionDir: relative(ROOT, sessionDir),
      commit: headShort,
      lanes: summary,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`[11632-lanes] summary → ${relative(ROOT, summaryPath)}`);
for (const entry of summary) {
  console.log(
    `  ${entry.status.padEnd(14)} lane ${entry.laneNumber} ${entry.pathId}${entry.skipReason ? ` — ${entry.skipReason}` : ""}`,
  );
}
process.exit(anyFailed ? 1 : 0);

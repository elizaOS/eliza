#!/usr/bin/env node
/**
 * Ordered live-lane driver for the LifeOps HITL validation run (issue #11632).
 *
 * Loads the worktree `.env` into `process.env` with the same optional-dotenv
 * convention as packages/scripts/test-env.mjs (`override: false`, manual-parse
 * fallback when dotenv is not installed), runs the read-only collector
 * pre-pass, then executes the live lanes serially. Each lane is gated on the
 * connector groups exported by collect-11632-live-validation-status.mjs; a
 * blocked lane prints `SKIP <lane>: missing <vars>` and never fails the run.
 *
 * Lane stdout+stderr tee to the exact filenames the collector's
 * `existingEvidence` parsers grep — owner-agent-permission-matrix.txt,
 * plugin-google-live.txt, plugin-x-live.txt under
 * reports/lifeops-live-validation/11632-status/ — and the remaining lanes log
 * into a datestamped session dir next to them, alongside summary.json.
 *
 * A lane is only `live-proven` when it exits 0 with zero skipped tests in its
 * vitest summary; skipped live describes downgrade it to `ran-with-skips`,
 * and a nonzero exit records `failed` (summary.json never hides a red lane
 * behind the three green-path statuses). Env var NAMES are printed for
 * readiness; env var VALUES are never logged.
 *
 * Usage:
 *   node scripts/lifeops/run-11632-live-lanes.mjs            # all ready lanes
 *   node scripts/lifeops/run-11632-live-lanes.mjs --dry-run  # readiness only
 *   node scripts/lifeops/run-11632-live-lanes.mjs --lane=3   # one lane
 */
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  CONNECTOR_GROUPS,
  groupStatus,
} from "./collect-11632-live-validation-status.mjs";

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

/**
 * Lane order mirrors the collector's `nextCommands`: keyless proof first, then
 * connector-scoped live suites, then the model-gated LifeOps lanes. `gates`
 * are CONNECTOR_GROUPS ids; lane 1 has none because the permission matrix is
 * deliberately credential-free (it gates itself on LIFEOPS_PERMISSION_MATRIX).
 * Lane 3's plugin-x tests call dotenv.config() against the plugin cwd with
 * override:false, so the env injected here wins over any plugin-local .env.
 * Lane 5 runs the shared live-e2e vitest lane; its include globs are derived
 * from the resolved eliza workspace root (packages/test/vitest/e2e.config.ts),
 * so the same command collects the PA live e2e files from both the flat
 * elizaOS checkout and the nested `eliza/` consumer layout.
 */
const LANES = [
  {
    n: 1,
    id: "permission-matrix",
    gates: [],
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
    id: "plugin-google-live",
    gates: ["google"],
    env: { TEST_LANE: "post-merge", ELIZA_LIVE_TEST: "1" },
    command: ["bun", "run", "--cwd", "plugins/plugin-google", "test"],
    logPath: () => join(STATUS_DIR, "plugin-google-live.txt"),
  },
  {
    n: 3,
    id: "plugin-x-live",
    gates: ["x"],
    env: { TEST_LANE: "post-merge", ELIZA_LIVE_TEST: "1" },
    command: ["bun", "run", "--cwd", "plugins/plugin-x", "test"],
    logPath: () => join(STATUS_DIR, "plugin-x-live.txt"),
  },
  {
    n: 4,
    id: "pa-background-real",
    gates: ["model"],
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
    id: "pa-live-e2e",
    gates: ["model"],
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

async function loadDotenv() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ path: file, override: false, quiet: true });
  } catch {
    // dotenv is an optional dep (not hoisted at the repo root); fall back to
    // the same minimal parser test-env.mjs uses so the driver needs no deps.
    const text = readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
      if (!match) continue;
      const [, key, raw] = match;
      if (process.env[key]) continue;
      process.env[key] = raw.replace(/^['"]|['"]$/g, "");
    }
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, lane: null };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (/^--lane=\d+$/.test(arg)) {
      args.lane = Number(arg.slice("--lane=".length));
    } else if (arg === "--help") {
      console.log(
        "Usage: node scripts/lifeops/run-11632-live-lanes.mjs [--dry-run] [--lane=<n>]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error(
        "Usage: node scripts/lifeops/run-11632-live-lanes.mjs [--dry-run] [--lane=<n>]",
      );
      process.exit(2);
    }
  }
  if (args.lane !== null && !LANES.some((lane) => lane.n === args.lane)) {
    console.error(`--lane must be one of 1..${LANES.length}`);
    process.exit(2);
  }
  return args;
}

/** Missing env var NAMES (never values) across a lane's gate groups. */
function laneReadiness(lane) {
  const missing = [];
  for (const id of lane.gates) {
    const group = CONNECTOR_GROUPS.find((entry) => entry.id === id);
    if (!group) {
      throw new Error(`lane ${lane.id}: unknown connector group '${id}'`);
    }
    const status = groupStatus(group);
    if (status.readyForOperatorRun) continue;
    missing.push(...status.missingRequiredAll);
    if (status.missingRequiredAny.length > 0) {
      missing.push(`one of: ${status.missingRequiredAny.join("|")}`);
    }
  }
  return { ready: missing.length === 0, missing };
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

await loadDotenv();
const args = parseArgs(process.argv.slice(2));

if (args.dryRun) {
  console.log(
    "[11632-lanes] dry run — lane readiness from .env + ambient env (nothing executed):",
  );
  for (const lane of LANES) {
    const { ready, missing } = laneReadiness(lane);
    if (ready) {
      console.log(`READY lane ${lane.n} ${lane.id}`);
    } else {
      console.log(`SKIP ${lane.id}: missing ${missing.join(", ")}`);
    }
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
  const { ready, missing } = laneReadiness(lane);
  if (!ready) {
    const skipReason = `missing ${missing.join(", ")}`;
    console.log(`SKIP ${lane.id}: ${skipReason}`);
    summary.push({
      lane: lane.id,
      laneNumber: lane.n,
      status: "skipped",
      skipReason,
      logPath: null,
    });
    continue;
  }

  const logPath = lane.logPath(sessionDir);
  console.log(
    `[11632-lanes] lane ${lane.n} ${lane.id}: ${lane.command.join(" ")} → ${relative(ROOT, logPath)}`,
  );
  const result = await runCommand(lane.command, lane.env, logPath);
  const counts = parseVitestCounts(readFileSync(logPath, "utf8"));
  const { status, skipReason } = laneOutcome(result, counts);
  if (status === "failed") anyFailed = true;
  console.log(
    `[11632-lanes] lane ${lane.n} ${lane.id}: ${status}${skipReason ? ` (${skipReason})` : ""} — ${counts.passed} passed | ${counts.failed} failed | ${counts.skipped} skipped`,
  );
  summary.push({
    lane: lane.id,
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
    `  ${entry.status.padEnd(14)} lane ${entry.laneNumber} ${entry.lane}${entry.skipReason ? ` — ${entry.skipReason}` : ""}`,
  );
}
process.exit(anyFailed ? 1 : 0);

/**
 * One-command orchestrator for a fully-artifacted e2e run (#15972): pins a
 * run id, boots the PostHog capture sink, exports the artifact/trajectory
 * env knobs, executes the selected lanes with per-lane logs, sweeps the
 * non-Playwright outputs into the run, generates the test viewer, and
 * (optionally) hands the whole corpus to the AI reviewer. Every lane failure
 * is recorded honestly in `<run>/lanes.json` and the process exit code —
 * lanes never mask each other.
 *
 * Lanes:
 *   app        packages/app Playwright ui-smoke (per-test reporter active)
 *   ui         every packages/ui test:*-e2e runner (continue-on-error)
 *   scenarios  scenario-runner deterministic PR lane (keyless, trajectories)
 *   audit      packages/app audit:app (screenshots + OCR triage)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRunId, runDir } from "./contract.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function parseArgs(argv) {
  const args = {
    lanes: ["app", "scenarios"],
    runId: null,
    aiReview: false,
    open: false,
    posthogPort: 8422,
    uiLanes: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lanes") args.lanes = argv[++i].split(",");
    else if (arg === "--run") args.runId = argv[++i];
    else if (arg === "--ai-review") args.aiReview = true;
    else if (arg === "--open") args.open = true;
    else if (arg === "--posthog-port") args.posthogPort = Number(argv[++i]);
    else if (arg === "--ui-lanes") args.uiLanes = argv[++i].split(",");
    else {
      console.error(`[e2e-run] unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function runCommand(command, commandArgs, { cwd, env, logFile }) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const out = fs.createWriteStream(logFile, { flags: "a" });
    const child = spawn(command, commandArgs, {
      cwd: cwd ?? REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stamp = (chunk) =>
      `${String(chunk)
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => `${new Date().toISOString()} ${line}`)
        .join("\n")}\n`;
    child.stdout.on("data", (chunk) => out.write(stamp(chunk)));
    child.stderr.on("data", (chunk) => out.write(stamp(chunk)));
    child.on("close", (code) => {
      out.end();
      resolve({
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: code ?? -1,
      });
    });
  });
}

/** packages/ui test:*-e2e script names (the bespoke browser runners). */
function listUiE2eLanes() {
  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "packages", "ui", "package.json"),
      "utf8",
    ),
  );
  return Object.keys(pkg.scripts).filter((name) =>
    /^test:[a-z-]+-e2e$/.test(name),
  );
}

/**
 * Map a packages/ui e2e script to the sweeper's test ids: the script command
 * names its runner .mjs, whose `__e2e__` directory owns `output*` dirs — the
 * same shape sweep.mjs turns into `ui-e2e:<lane>` entries. One script can own
 * several output dirs (default + webkit), so every candidate id is returned.
 */
function uiScriptTestIds(scriptName) {
  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "packages", "ui", "package.json"),
      "utf8",
    ),
  );
  const command = pkg.scripts[scriptName] ?? "";
  const match = command.match(/packages\/ui\/(src\/\S+__e2e__)\//);
  if (!match) return [];
  const e2eDir = path.join(REPO_ROOT, "packages", "ui", match[1]);
  if (!fs.existsSync(e2eDir)) return [];
  const relBase = path.relative(
    path.join(REPO_ROOT, "packages", "ui", "src"),
    e2eDir,
  );
  return fs
    .readdirSync(e2eDir)
    .filter((name) => name.startsWith("output"))
    .map((name) => {
      const laneName = `${relBase}/${name}`
        .replace(/\/__e2e__\/output/, "#")
        .replace(/#$/, "#default")
        .replace(/^#/, "root#");
      return `ui-e2e:${laneName}`;
    });
}

const args = parseArgs(process.argv);
const runId = args.runId ?? resolveRunId();
const root = runDir(REPO_ROOT, runId);
const lanesDir = path.join(root, "lanes");
fs.mkdirSync(lanesDir, { recursive: true });

const baseEnv = {
  ELIZA_E2E_RUN_ID: runId,
  ELIZA_E2E_ARTIFACTS: process.env.ELIZA_E2E_ARTIFACTS ?? "1",
  ELIZA_TRAJECTORY_LOGGING: "true",
  ELIZA_TRAJECTORY_DIR: path.join(root, "trajectories-raw"),
};

// PostHog sink: session capture lands inside this run. The sink is optional
// infrastructure — a failure to bind is a hard error (the run promised
// capture), not a silent skip.
const sink = spawn(
  "node",
  [
    path.join(REPO_ROOT, "scripts", "e2e-artifacts", "posthog-sink.mjs"),
    "--port",
    String(args.posthogPort),
    "--repo-root",
    REPO_ROOT,
    "--run-id",
    runId,
  ],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...baseEnv },
  },
);
const sinkExit = new Promise((resolve) => sink.on("close", resolve));
baseEnv.ELIZA_E2E_POSTHOG_HOST = `http://127.0.0.1:${args.posthogPort}`;

const laneResults = [];
const laneStatuses = {};

async function runLane(name, fn) {
  console.log(`[e2e-run] lane ${name} starting`);
  const result = await fn();
  laneResults.push({ name, ...result });
  console.log(
    `[e2e-run] lane ${name} finished exit=${result.exitCode} (${result.finishedAt})`,
  );
}

try {
  for (const lane of args.lanes) {
    if (lane === "app") {
      await runLane("app", () =>
        runCommand(
          "node",
          [
            "scripts/run-ui-playwright.mjs",
            "--config",
            "playwright.ui-smoke.config.ts",
          ],
          {
            cwd: path.join(REPO_ROOT, "packages", "app"),
            env: { ...baseEnv, ELIZA_E2E_LANE: "app-ui-smoke" },
            logFile: path.join(lanesDir, "app.log"),
          },
        ),
      );
    } else if (lane === "ui") {
      const uiLanes = args.uiLanes ?? listUiE2eLanes();
      for (const scriptName of uiLanes) {
        const result = await runCommand("bun", ["run", scriptName], {
          cwd: path.join(REPO_ROOT, "packages", "ui"),
          env: baseEnv,
          logFile: path.join(lanesDir, `ui-${scriptName}.log`),
        });
        laneResults.push({ name: `ui:${scriptName}`, ...result });
        console.log(`[e2e-run] ui lane ${scriptName} exit=${result.exitCode}`);
        // The sweeper labels each output dir; map the script's output dirs
        // to statuses so swept entries carry the real exit code.
        for (const testId of uiScriptTestIds(scriptName)) {
          laneStatuses[testId] = result.exitCode === 0 ? "passed" : "failed";
        }
      }
    } else if (lane === "scenarios") {
      await runLane("scenarios", () =>
        runCommand("bun", ["run", "test:deterministic:e2e"], {
          cwd: path.join(REPO_ROOT, "packages", "scenario-runner"),
          env: baseEnv,
          logFile: path.join(lanesDir, "scenarios.log"),
        }),
      );
    } else if (lane === "audit") {
      await runLane("audit", () =>
        runCommand("bun", ["run", "audit:app"], {
          cwd: path.join(REPO_ROOT, "packages", "app"),
          env: baseEnv,
          logFile: path.join(lanesDir, "audit.log"),
        }),
      );
    } else {
      console.error(`[e2e-run] unknown lane: ${lane}`);
      process.exitCode = 2;
    }
  }
} finally {
  sink.kill("SIGTERM");
  await sinkExit;
}

fs.writeFileSync(
  path.join(root, "lane-status.json"),
  `${JSON.stringify(laneStatuses, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(root, "lanes.json"),
  `${JSON.stringify({ runId, lanes: laneResults }, null, 2)}\n`,
);

// Fold the non-Playwright outputs into the run, then build the viewer.
const sweep = await runCommand(
  "node",
  ["scripts/e2e-artifacts/sweep.mjs", "--run", runId],
  { env: baseEnv, logFile: path.join(lanesDir, "sweep.log") },
);
const viewer = await runCommand(
  "node",
  [
    "scripts/e2e-viewer/generate.mjs",
    "--run",
    runId,
    ...(args.open ? ["--open"] : []),
  ],
  { env: baseEnv, logFile: path.join(lanesDir, "viewer.log") },
);
let aiReview = null;
if (args.aiReview) {
  aiReview = await runCommand(
    "node",
    ["scripts/e2e-ai-review/run.mjs", "--run", runId],
    { env: baseEnv, logFile: path.join(lanesDir, "ai-review.log") },
  );
}

const failed = laneResults.filter((lane) => lane.exitCode !== 0);
console.log(
  `[e2e-run] done run=${runId} lanes=${laneResults.length} failed=${failed.length} sweep=${sweep.exitCode} viewer=${viewer.exitCode}${aiReview ? ` aiReview=${aiReview.exitCode}` : ""}`,
);
console.log(`[e2e-run] viewer: ${path.join(root, "viewer", "index.html")}`);
if (failed.length > 0 || sweep.exitCode !== 0 || viewer.exitCode !== 0) {
  process.exitCode = 1;
}

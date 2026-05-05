#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

const QUICK_TASK_IDS = new Set([
  "mobile-artifacts",
  "app-core-focused",
  "agent-focused",
  "lifeops-focused",
  "training-focused",
  "cloud-api-key-client",
  "model-data",
]);

const TASKS = [
  {
    id: "docs",
    tier: 2,
    optionalScript: "scripts/launch-qa/check-docs.mjs",
    command: "node",
    args: ["scripts/launch-qa/check-docs.mjs", "--json"],
    description: "Markdown links and documented command references",
  },
  {
    id: "mobile-artifacts",
    tier: 1,
    optionalScript: "scripts/launch-qa/check-mobile-artifacts.mjs",
    command: "node",
    args: ["scripts/launch-qa/check-mobile-artifacts.mjs", "--json"],
    description: "Static iOS/Android artifact and script validation",
  },
  {
    id: "model-data",
    tier: 0,
    optionalScript: "scripts/launch-qa/check-model-data.mjs",
    command: "node",
    args: ["scripts/launch-qa/check-model-data.mjs", "--json"],
    description:
      "Offline model dataset schema, redaction, and budget validation",
  },
  {
    id: "app-core-focused",
    tier: 0,
    command: "bunx",
    args: [
      "vitest",
      "run",
      "--config",
      "packages/app-core/vitest.config.ts",
      "packages/app-core/src/components/permissions/StreamingPermissions.test.ts",
      "packages/app-core/src/components/pages/ConfigPageView.test.tsx",
      "packages/app-core/src/components/settings/CapabilitiesSection.test.tsx",
      "packages/app-core/src/components/shell/ComputerUseApprovalOverlay.test.tsx",
      "packages/app-core/src/services/__tests__/account-pool.test.ts",
      "packages/app-core/src/api/auth-pairing-compat-routes.test.ts",
      "packages/app-core/src/api/computer-use-compat-routes.test.ts",
      "packages/app-core/test/onboarding/launch-qa-remote-target.test.tsx",
      "packages/app-core/test/onboarding/pre-seed-android-local-runtime.test.ts",
    ],
    description:
      "Focused app-core settings, account routing, remote pairing, onboarding, and Computer Use tests",
  },
  {
    id: "agent-focused",
    tier: 0,
    command: "bunx",
    args: [
      "vitest",
      "run",
      "--config",
      "packages/agent/vitest.config.ts",
      "packages/agent/src/api/agent-status-routes.test.ts",
      "packages/agent/src/services/launchpads/fake-wallet-launchpad.test.ts",
      "packages/agent/src/services/launchpads/launchpad-engine.test.ts",
      "packages/agent/src/actions/launchpad-launch.test.ts",
    ],
    description: "Focused agent status and launchpad safety tests",
  },
  {
    id: "lifeops-focused",
    tier: 0,
    command: "bunx",
    args: [
      "vitest",
      "run",
      "--config",
      "plugins/app-lifeops/vitest.config.ts",
      "plugins/app-lifeops/test/fake-connectors.contract.test.ts",
      "plugins/app-lifeops/test/followup-tracker.test.ts",
      "plugins/app-lifeops/src/hooks/useGoogleLifeOpsConnector.test.ts",
    ],
    description: "Focused LifeOps follow-up and connector refresh tests",
  },
  {
    id: "training-focused",
    tier: 0,
    command: "bun",
    args: ["run", "--cwd", "plugins/app-training", "test"],
    description: "App-training dataset, privacy, optimizer, and trigger tests",
  },
  {
    id: "app-typecheck",
    tier: 1,
    command: "bun",
    args: ["run", "--cwd", "packages/app", "typecheck"],
    description: "Host app typecheck",
  },
  {
    id: "app-core-typecheck",
    tier: 1,
    command: "bun",
    args: ["run", "--cwd", "packages/app-core", "typecheck"],
    description: "App-core typecheck",
  },
  {
    id: "agent-typecheck",
    tier: 1,
    command: "bun",
    args: ["run", "--cwd", "packages/agent", "typecheck"],
    description: "Agent package typecheck",
  },
  {
    id: "cloud-typecheck",
    tier: 1,
    command: "bun",
    args: ["run", "--cwd", "cloud", "typecheck"],
    description: "Cloud package split typecheck",
  },
  {
    id: "ui-smoke",
    tier: 2,
    command: "node",
    args: ["scripts/launch-qa/run-ui-smoke-stub.mjs"],
    description: "Deterministic stub-stack Playwright UI smoke suite",
  },
  {
    id: "cloud-api-key-redaction",
    tier: 1,
    cwd: "cloud",
    command: "bun",
    args: [
      "test",
      "--preload",
      "./packages/tests/e2e/preload.ts",
      "packages/tests/e2e/v1/api-keys.test.ts",
      "--timeout",
      "120000",
    ],
    description: "Cloud API-key create/list redaction e2e",
  },
  {
    id: "cloud-api-key-client",
    tier: 0,
    cwd: "cloud",
    command: "bun",
    args: [
      "test",
      "--preload",
      "./packages/tests/load-env.ts",
      "packages/lib/client/api-keys.test.ts",
    ],
    env: {
      SKIP_DB_DEPENDENT: "1",
      SKIP_SERVER_CHECK: "true",
    },
    description: "Cloud API-key client helper redaction contract",
  },
];

function parseArgs(argv) {
  const args = {
    suite: "quick",
    only: null,
    skip: new Set(),
    dryRun: false,
    json: false,
    list: false,
    artifactsDir: path.join(repoRoot, "launchdocs", "artifacts", "launch-qa"),
    continueOnFailure: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--suite") {
      args.suite = argv[++i] ?? "";
    } else if (arg.startsWith("--suite=")) {
      args.suite = arg.slice("--suite=".length);
    } else if (arg === "--only") {
      args.only = new Set((argv[++i] ?? "").split(",").filter(Boolean));
    } else if (arg.startsWith("--only=")) {
      args.only = new Set(
        arg.slice("--only=".length).split(",").filter(Boolean),
      );
    } else if (arg === "--skip") {
      for (const id of (argv[++i] ?? "").split(",")) {
        if (id) args.skip.add(id);
      }
    } else if (arg.startsWith("--skip=")) {
      for (const id of arg.slice("--skip=".length).split(",")) {
        if (id) args.skip.add(id);
      }
    } else if (arg === "--artifacts-dir") {
      args.artifactsDir = path.resolve(argv[++i] ?? args.artifactsDir);
    } else if (arg.startsWith("--artifacts-dir=")) {
      args.artifactsDir = path.resolve(arg.slice("--artifacts-dir=".length));
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--list") {
      args.list = true;
    } else if (arg === "--continue-on-failure") {
      args.continueOnFailure = true;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["quick", "release", "nightly", "all"].includes(args.suite)) {
    throw new Error(
      `Unknown suite "${args.suite}". Use quick, release, nightly, or all.`,
    );
  }
  return args;
}

function taskExists(task) {
  return (
    !task.optionalScript ||
    fs.existsSync(path.join(repoRoot, task.optionalScript))
  );
}

function tasksForSuite(suite) {
  if (suite === "quick") {
    return TASKS.filter((task) => QUICK_TASK_IDS.has(task.id));
  }
  if (suite === "release") {
    return TASKS.filter((task) => task.tier <= 1);
  }
  if (suite === "nightly" || suite === "all") {
    return [...TASKS];
  }
  return [];
}

export function selectTasks(options) {
  let selected = tasksForSuite(options.suite);
  if (options.only) {
    selected = TASKS.filter((task) => options.only.has(task.id));
  }
  return selected.filter((task) => !options.skip.has(task.id));
}

function usage() {
  return `Usage: node scripts/launch-qa/run.mjs [--suite quick|release|nightly|all] [--only a,b] [--skip a,b] [--dry-run] [--json] [--list] [--continue-on-failure]

Suites:
  quick    Fast launch gates intended for local iteration.
  release  Quick gates plus typechecks and cloud API redaction.
  nightly  Release gates plus browser/cloud smoke where configured.
  all      Alias for nightly.
`;
}

async function runTask(task, options) {
  if (!taskExists(task)) {
    return {
      id: task.id,
      status: "skipped",
      reason: `optional script missing: ${task.optionalScript}`,
    };
  }

  if (options.dryRun) {
    return {
      id: task.id,
      status: "dry-run",
      command: [task.command, ...task.args].join(" "),
      cwd: task.cwd ?? ".",
    };
  }

  fs.mkdirSync(options.artifactsDir, { recursive: true });
  const logPath = path.join(options.artifactsDir, `${task.id}.log`);
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    const child = spawn(task.command, task.args, {
      cwd: task.cwd ? path.join(repoRoot, task.cwd) : repoRoot,
      env: { ...process.env, ...(task.env ?? {}) },
      shell: process.platform === "win32",
    });
    const chunks = [];
    const record = (chunk) => {
      chunks.push(Buffer.from(chunk));
      process.stdout.write(chunk);
    };
    const recordErr = (chunk) => {
      chunks.push(Buffer.from(chunk));
      process.stderr.write(chunk);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", recordErr);
    child.on("error", (error) => {
      const output = Buffer.concat(chunks).toString("utf8");
      fs.writeFileSync(
        logPath,
        `${output}\n[launch-qa] ${error.stack ?? error.message}\n`,
      );
      resolve({
        id: task.id,
        status: "failed",
        exitCode: null,
        durationMs: Date.now() - startedAt,
        logPath,
        error: error.message,
      });
    });
    child.on("exit", (code, signal) => {
      const output = Buffer.concat(chunks).toString("utf8");
      fs.writeFileSync(logPath, output);
      resolve({
        id: task.id,
        status: code === 0 ? "passed" : "failed",
        exitCode: code,
        signal,
        durationMs: Date.now() - startedAt,
        logPath,
      });
    });
  });
}

export async function runLaunchQa(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return { ok: true, results: [] };
  }

  const tasks = selectTasks(options);
  if (options.list || options.dryRun) {
    const listed = tasks.map((task) => ({
      id: task.id,
      tier: task.tier,
      description: task.description,
      command: [task.command, ...task.args].join(" "),
      cwd: task.cwd ?? ".",
      available: taskExists(task),
    }));
    if (options.json) {
      console.log(JSON.stringify({ tasks: listed }, null, 2));
    } else {
      for (const task of listed) {
        const availability = task.available ? "" : " (missing optional script)";
        console.log(
          `${task.id.padEnd(26)} tier=${task.tier} ${task.command}${availability}`,
        );
      }
    }
    return { ok: true, tasks: listed, results: [] };
  }

  const results = [];
  for (const task of tasks) {
    console.log(`\n[launch-qa] ${task.id}: ${task.description}`);
    const result = await runTask(task, options);
    results.push(result);
    if (result.status === "failed" && !options.continueOnFailure) {
      break;
    }
  }

  const summary = {
    ok: results.every(
      (result) => result.status === "passed" || result.status === "skipped",
    ),
    suite: options.suite,
    artifactsDir: options.artifactsDir,
    results,
  };
  fs.mkdirSync(options.artifactsDir, { recursive: true });
  fs.writeFileSync(
    path.join(options.artifactsDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const passed = results.filter(
      (result) => result.status === "passed",
    ).length;
    const skipped = results.filter(
      (result) => result.status === "skipped",
    ).length;
    const failed = results.filter(
      (result) => result.status === "failed",
    ).length;
    console.log(
      `\n[launch-qa] passed=${passed} skipped=${skipped} failed=${failed}`,
    );
    console.log(`[launch-qa] artifacts: ${options.artifactsDir}`);
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const summary = await runLaunchQa();
    process.exit(summary.ok ? 0 : 1);
  } catch (error) {
    console.error(
      `[launch-qa] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

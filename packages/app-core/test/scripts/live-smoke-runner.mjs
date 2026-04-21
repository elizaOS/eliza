import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTestEnv,
  resolveNodeCmd,
  runManagedTestCommand,
} from "./managed-test-command.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Script lives at eliza/packages/app-core/test/scripts/ — repo root is 5 levels up.
const repoRoot = path.resolve(here, "..", "..", "..", "..", "..");
const appCoreScriptsDir = path.join(
  repoRoot,
  "eliza",
  "packages",
  "app-core",
  "scripts",
);
const bunCmd = process.env.npm_execpath || process.env.BUN || "bun";
const nodeCmd = resolveNodeCmd();
const truthyValues = new Set(["1", "true", "yes", "on"]);

function buildLiveTestEnv(cwd) {
  return {
    ...buildTestEnv(cwd),
    ELIZA_LIVE_TEST: "1",
    MILADY_LIVE_TEST: "1",
  };
}

function envFlagEnabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value ? truthyValues.has(value) : false;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function workspaceHasScript(cwd, scriptName) {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const pkg = readJson(packageJsonPath);
    return typeof pkg?.scripts?.[scriptName] === "string";
  } catch {
    return false;
  }
}

function resolvePluginPackageRoot(dirName) {
  const candidates = [
    path.join(repoRoot, "eliza", "plugins", dirName, "typescript"),
    path.join(repoRoot, "eliza", "plugins", dirName),
    path.join(repoRoot, "eliza", "packages", dirName),
    path.join(repoRoot, "plugins", dirName, "typescript"),
    path.join(repoRoot, "plugins", dirName),
    path.join(repoRoot, "packages", dirName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return null;
}

function countAvailableLocalPluginPackages() {
  const manifestPath = path.join(repoRoot, "plugins.json");
  if (!fs.existsSync(manifestPath)) {
    return 0;
  }

  try {
    const manifest = readJson(manifestPath);
    const seen = new Set();
    let count = 0;

    for (const plugin of manifest.plugins ?? []) {
      if (
        plugin?.category === "app" ||
        typeof plugin?.dirName !== "string" ||
        typeof plugin?.npmName !== "string" ||
        !plugin.npmName.includes("/plugin-")
      ) {
        continue;
      }
      if (seen.has(plugin.npmName)) {
        continue;
      }
      const packageRoot = resolvePluginPackageRoot(plugin.dirName);
      if (!packageRoot) {
        continue;
      }
      seen.add(plugin.npmName);
      count += 1;
    }

    return count;
  } catch {
    return 0;
  }
}

async function _isPortBusy(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.listen(port, () => {
      server.close(() => resolve(false));
    });
  });
}

async function getRunSkipReason(run) {
  if (run.skipEnvVar && envFlagEnabled(run.skipEnvVar)) {
    return `${run.skipEnvVar}=1`;
  }

  if (!fs.existsSync(path.join(run.cwd, "package.json"))) {
    return `${path.relative(repoRoot, run.cwd) || "."} is not available in this checkout`;
  }

  if (run.scriptName && !workspaceHasScript(run.cwd, run.scriptName)) {
    return `${run.scriptName} is not defined in ${path.relative(repoRoot, path.join(run.cwd, "package.json"))}`;
  }

  if (typeof run.getSkipReason === "function") {
    return await run.getSkipReason();
  }

  return null;
}

const runs = [
  {
    lockName: "ui-playwright",
    label: "ui-playwright",
    command: nodeCmd,
    args: [path.join(appCoreScriptsDir, "run-ui-smoke-playwright-suite.mjs")],
    cwd: repoRoot,
    env: {
      ...process.env,
      ELIZA_LIVE_TEST: "1",
      MILADY_LIVE_TEST: "1",
    },
  },
  {
    lockName: "ui-storybook-e2e",
    label: "ui-storybook-e2e",
    command: bunCmd,
    args: ["run", "test:e2e"],
    cwd: path.join(repoRoot, "eliza", "apps", "app-companion"),
    scriptName: "test:e2e",
  },
  {
    lockName: "live-plugins",
    label: "live-plugins",
    command: bunCmd,
    args: ["run", "test:live:plugins"],
    cwd: repoRoot,
    scriptName: "test:live:plugins",
    skipEnvVar: "ELIZA_SKIP_PLUGIN_LIVE_SMOKE",
    getSkipReason() {
      if (countAvailableLocalPluginPackages() === 0) {
        return "no first-party plugin packages are available in this checkout";
      }
      return null;
    },
  },
  {
    lockName: "cloud-e2e-smoke",
    label: "cloud-e2e-smoke",
    command: bunCmd,
    args: ["run", "test:e2e:smoke"],
    cwd: path.join(repoRoot, "eliza", "cloud"),
    scriptName: "test:e2e:smoke",
    skipEnvVar: "ELIZA_SKIP_CLOUD_LIVE_SMOKE",
    env: {
      ...buildLiveTestEnv(path.join(repoRoot, "eliza", "cloud")),
      TEST_SERVER_PORT: "3104",
    },
  },
  {
    lockName: "eliza-e2e-smoke",
    label: "eliza-e2e-smoke",
    command: bunCmd,
    args: ["run", "test:e2e:smoke"],
    cwd: path.join(repoRoot, "eliza", "packages", "typescript"),
    scriptName: "test:e2e:smoke",
    skipEnvVar: "ELIZA_SKIP_ELIZA_LIVE_SMOKE",
  },
  {
    lockName: "steward-fi-e2e-smoke",
    label: "steward-fi-e2e-smoke",
    command: bunCmd,
    args: ["run", "test:e2e:smoke"],
    cwd: path.join(repoRoot, "eliza", "steward-fi"),
    scriptName: "test:e2e:smoke",
    skipEnvVar: "ELIZA_SKIP_STEWARD_FI_LIVE_SMOKE",
  },
];

for (const run of runs) {
  const skipReason = await getRunSkipReason(run);
  if (skipReason) {
    console.log(`[test-runner] SKIP ${run.label}: ${skipReason}`);
    continue;
  }

  await runManagedTestCommand({
    repoRoot,
    lockName: run.lockName,
    label: run.label,
    command: run.command,
    args: run.args,
    cwd: run.cwd,
    env: run.env ?? buildLiveTestEnv(run.cwd),
  });
}

await runManagedTestCommand({
  repoRoot,
  lockName: "repo-live-smoke-summary",
  label: "repo-live-smoke-summary",
  command: nodeCmd,
  args: [path.join(appCoreScriptsDir, "audit-live-test-surface.mjs")],
  cwd: repoRoot,
  env: buildLiveTestEnv(repoRoot),
});

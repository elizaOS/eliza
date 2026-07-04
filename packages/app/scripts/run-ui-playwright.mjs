/**
 * Command-line helper for the Run Ui Playwright app packaging, mobile, or
 * Playwright automation lane.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort } from "../test/utils/get-free-port.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appDir, "..", "..");
const workspaceRoot = path.resolve(repoRoot, "..");
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);
const playwrightArgs = process.argv.slice(2);
const uiSmokeViewLockDir = path.join(
  repoRoot,
  ".turbo",
  "ui-smoke-view-bundles.lock",
);
const uiSmokeTempPrefixes = ["eliza-ui-smoke-stub-", "eliza-ui-smoke-live-"];

function resolvePlaywrightCommand() {
  // On Windows the bin shim differs by package manager: bun emits
  // `playwright.exe` (a real executable), npm emits `playwright.cmd` (a shell
  // shim). Try both so the runner works regardless of how deps were installed.
  const binaryNames =
    process.platform === "win32"
      ? ["playwright.exe", "playwright.cmd"]
      : ["playwright"];
  for (const dir of [
    path.join(appDir, "node_modules", ".bin"),
    path.join(repoRoot, "node_modules", ".bin"),
    path.join(workspaceRoot, "node_modules", ".bin"),
  ]) {
    for (const binaryName of binaryNames) {
      const candidate = path.join(dir, binaryName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return binaryNames[0];
}

function resolveExecutableFromPath(command) {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  if (!pathValue) return null;

  const hasExtension = path.extname(command).length > 0;
  const pathExts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((ext) => ext.trim())
          .filter(Boolean)
      : [""];
  const binaryNames =
    process.platform === "win32" && !hasExtension
      ? pathExts.map((ext) => `${command}${ext.toLowerCase()}`)
      : [command];

  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const binaryName of binaryNames) {
      const candidate = path.join(dir, binaryName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveBunCommand() {
  const bunFromEnv = process.env.BUN?.trim();
  if (bunFromEnv) {
    if (fs.existsSync(bunFromEnv)) {
      return bunFromEnv;
    }
    const bunEnvFromPath = resolveExecutableFromPath(bunFromEnv);
    if (bunEnvFromPath) {
      return bunEnvFromPath;
    }
  }

  if (
    typeof process.versions.bun === "string" &&
    typeof process.execPath === "string" &&
    process.execPath.length > 0 &&
    fs.existsSync(process.execPath)
  ) {
    return process.execPath;
  }

  const bunInstallRoot = process.env.BUN_INSTALL?.trim();
  if (bunInstallRoot) {
    const bunFromInstall = path.join(
      bunInstallRoot,
      "bin",
      process.platform === "win32" ? "bun.exe" : "bun",
    );
    if (fs.existsSync(bunFromInstall)) {
      return bunFromInstall;
    }
  }

  const homeBun = path.join(
    os.homedir(),
    ".bun",
    "bin",
    process.platform === "win32" ? "bun.exe" : "bun",
  );
  if (fs.existsSync(homeBun)) {
    return homeBun;
  }

  const bunFromPath = resolveExecutableFromPath("bun");
  if (bunFromPath) {
    return bunFromPath;
  }

  return process.platform === "win32" ? "bun.exe" : "bun";
}

function looksLikeBun(command) {
  const binaryName = path.basename(command).toLowerCase();
  return binaryName === "bun" || binaryName === "bun.exe";
}

function resolveNodeCommand() {
  for (const candidate of [
    process.env.ELIZA_NODE_PATH?.trim(),
    process.env.npm_node_execpath?.trim(),
    process.execPath,
    resolveExecutableFromPath("node"),
  ]) {
    if (candidate && fs.existsSync(candidate) && !looksLikeBun(candidate)) {
      return candidate;
    }
  }

  return process.platform === "win32" ? "node.exe" : "node";
}

const env = { ...process.env };
delete env.NO_COLOR;
delete env.FORCE_COLOR;
delete env.CLICOLOR_FORCE;
env.BUN = env.BUN || resolveBunCommand();
env.ELIZA_NODE_PATH = env.ELIZA_NODE_PATH || resolveNodeCommand();

const bunBinDir = path.dirname(env.BUN);
const pathDelimiter = process.platform === "win32" ? ";" : ":";
const existingPath = env.PATH ?? env.Path ?? "";
env.PATH = existingPath
  ? `${bunBinDir}${pathDelimiter}${existingPath}`
  : bunBinDir;
if (process.platform === "win32") {
  env.Path = env.PATH;
}

function hasPlaywrightConfig(configName) {
  return (
    playwrightArgs.includes("--config") &&
    playwrightArgs.some((value) => value.includes(configName))
  );
}

function appendNodeOption(value, option) {
  const options =
    typeof value === "string" && value.trim().length > 0
      ? value.trim().split(/\s+/)
      : [];
  if (!options.includes(option)) {
    options.push(option);
  }
  return options.join(" ");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockOwnerPid(lockDir) {
  try {
    const owner = fs.readFileSync(path.join(lockDir, "owner"), "utf8");
    const pid = Number.parseInt(owner.split(/\r?\n/, 1)[0] ?? "", 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function removePathRecursive(targetPath, label) {
  const result = spawnSync("node", [cleanupHelperScript, targetPath], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `[ui-smoke] cleanup failed for ${label} with exit code ${
        result.status ?? 1
      }${detail ? `: ${detail}` : ""}`,
    );
  }
}

function acquireUiSmokeViewLock() {
  const staleAfterMs = 30 * 60 * 1000;
  let announcedWait = false;

  fs.mkdirSync(path.dirname(uiSmokeViewLockDir), { recursive: true });

  for (;;) {
    try {
      fs.mkdirSync(uiSmokeViewLockDir);
      fs.writeFileSync(
        path.join(uiSmokeViewLockDir, "owner"),
        `${process.pid}\n${new Date().toISOString()}\n`,
      );
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      let stat = null;
      try {
        stat = fs.statSync(uiSmokeViewLockDir);
      } catch {
        continue;
      }

      const ownerPid = readLockOwnerPid(uiSmokeViewLockDir);
      if (
        (ownerPid !== null && !isProcessAlive(ownerPid)) ||
        Date.now() - stat.mtimeMs > staleAfterMs
      ) {
        removePathRecursive(uiSmokeViewLockDir, "ui smoke view lock");
        continue;
      }

      if (!announcedWait) {
        console.log("[ui-smoke] Waiting for another UI smoke run to finish...");
        announcedWait = true;
      }
      sleepSync(250);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    removePathRecursive(uiSmokeViewLockDir, "ui smoke view lock");
  };
}

let releaseUiSmokeViewLock = null;

function releaseLocks() {
  if (releaseUiSmokeViewLock) {
    releaseUiSmokeViewLock();
    releaseUiSmokeViewLock = null;
  }
}

process.once("exit", releaseLocks);

function cleanupUiSmokeStateDirsForRun() {
  const runId = env.ELIZA_UI_SMOKE_RUN_ID?.trim();
  if (!runId) return;

  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !uiSmokeTempPrefixes.some((prefix) => entry.name.startsWith(prefix))
    ) {
      continue;
    }
    const stateDir = path.join(os.tmpdir(), entry.name);
    try {
      const owner = fs
        .readFileSync(path.join(stateDir, ".eliza-ui-smoke-run-id"), "utf8")
        .trim();
      if (owner === runId) {
        removePathRecursive(stateDir, "ui smoke state directory");
      }
    } catch {
      // Only remove dirs explicitly stamped with this runner's id.
    }
  }
}

async function getDistinctFreePort(excludedPorts = new Set()) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = Number(await getFreePort());
    if (!excludedPorts.has(port)) {
      return port;
    }
  }
  throw new Error("Could not allocate a distinct free port for UI smoke.");
}

if (hasPlaywrightConfig("playwright.electrobun.packaged.config.ts")) {
  env.NODE_OPTIONS = appendNodeOption(
    env.NODE_OPTIONS,
    "--conditions=eliza-source",
  );
}

if (hasPlaywrightConfig("playwright.ui-smoke.config.ts")) {
  env.ELIZA_UI_SMOKE_RUN_ID =
    env.ELIZA_UI_SMOKE_RUN_ID || `${process.pid}-${Date.now().toString(36)}`;
  if (env.ELIZA_UI_SMOKE_LIVE_STACK !== "1") {
    env.ELIZA_UI_SMOKE_FORCE_STUB = env.ELIZA_UI_SMOKE_FORCE_STUB || "1";
  }
  const reservedPorts = new Set();

  if (!env.ELIZA_UI_SMOKE_API_PORT) {
    const apiPort = await getDistinctFreePort(reservedPorts);
    env.ELIZA_UI_SMOKE_API_PORT = String(apiPort);
    env.ELIZA_API_PORT = env.ELIZA_API_PORT || String(apiPort);
  }
  reservedPorts.add(Number(env.ELIZA_UI_SMOKE_API_PORT));

  if (!env.ELIZA_UI_SMOKE_PORT) {
    const uiPort = await getDistinctFreePort(reservedPorts);
    env.ELIZA_UI_SMOKE_PORT = String(uiPort);
    env.ELIZA_PORT = env.ELIZA_PORT || String(uiPort);
  }
}

if (
  hasPlaywrightConfig("playwright.ui-smoke.config.ts") &&
  env.ELIZA_UI_SMOKE_SKIP_VIEW_BUILD !== "1"
) {
  releaseUiSmokeViewLock = acquireUiSmokeViewLock();
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "packages", "scripts", "build-views.mjs")],
    {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    },
  );
  const status = result.status ?? 1;
  if (status !== 0) {
    releaseLocks();
    process.exit(status);
  }
}

// The ui-smoke web server builds the renderer (`packages/app build:web`) whenever
// the dist is stale — in BOTH stub and live mode (see playwright-ui-live-stack.ts
// `viteRendererBuildNeeded` → `build:web`). That vite build needs linked
// workspace package dists during config load and renderer bundling:
// - @elizaos/shared/brand is imported by app.config.ts before Vite aliases apply.
// - @elizaos/core is bundled through its browser export.
// On a fresh CI checkout these dists may not exist, so the stack fails before any
// smoke spec runs. Build them first — gated only on the ui-smoke config (NOT on
// live mode), mirroring the view-build step above. Turbo-cached → a fast no-op
// when already up to date; skip with ELIZA_UI_SMOKE_SKIP_CORE_BUILD=1.
if (
  hasPlaywrightConfig("playwright.ui-smoke.config.ts") &&
  env.ELIZA_UI_SMOKE_SKIP_CORE_BUILD !== "1"
) {
  const coreBuild = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "packages", "scripts", "run-turbo.mjs"),
      "run",
      "build",
      "--filter=@elizaos/shared",
      "--filter=@elizaos/core",
    ],
    {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    },
  );
  if ((coreBuild.status ?? 1) !== 0) {
    releaseLocks();
    process.exit(coreBuild.status ?? 1);
  }
}

if (hasPlaywrightConfig("playwright.dev-smoke.config.ts")) {
  const reservedPorts = new Set();

  if (!env.ELIZA_DEV_SMOKE_API_PORT) {
    const apiPort = await getDistinctFreePort(reservedPorts);
    env.ELIZA_DEV_SMOKE_API_PORT = String(apiPort);
    env.ELIZA_API_PORT = String(apiPort);
  }
  reservedPorts.add(Number(env.ELIZA_DEV_SMOKE_API_PORT));

  if (!env.ELIZA_DEV_SMOKE_UI_PORT) {
    const uiPort = await getDistinctFreePort(reservedPorts);
    env.ELIZA_DEV_SMOKE_UI_PORT = String(uiPort);
    env.ELIZA_UI_PORT = String(uiPort);
  }

  env.ELIZA_DEV_SMOKE_STATE_DIR =
    env.ELIZA_DEV_SMOKE_STATE_DIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), "eliza-dev-smoke-"));
}

if (hasPlaywrightConfig("playwright.hmr.config.ts")) {
  const reservedPorts = new Set();

  if (!env.ELIZA_HMR_API_PORT) {
    const apiPort = await getDistinctFreePort(reservedPorts);
    env.ELIZA_HMR_API_PORT = String(apiPort);
    env.ELIZA_API_PORT = String(apiPort);
  }
  reservedPorts.add(Number(env.ELIZA_HMR_API_PORT));

  if (!env.ELIZA_HMR_UI_PORT) {
    const uiPort = await getDistinctFreePort(reservedPorts);
    env.ELIZA_HMR_UI_PORT = String(uiPort);
    env.ELIZA_UI_PORT = String(uiPort);
  }

  env.ELIZA_HMR_STATE_DIR =
    env.ELIZA_HMR_STATE_DIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), "eliza-hmr-"));
}

const playwrightCommand = resolvePlaywrightCommand();
const child = spawn(playwrightCommand, ["test", ...playwrightArgs], {
  cwd: appDir,
  env,
  stdio: "inherit",
  // A `.cmd` shim (npm on Windows) cannot be spawned without a shell (raises
  // EINVAL, hardened further by the CVE-2024-27980 fix). A `.exe` shim (bun on
  // Windows) and the POSIX `playwright` binary are real executables that need
  // no shell, so scope the shell to the `.cmd` case only.
  shell: process.platform === "win32" && playwrightCommand.endsWith(".cmd"),
});

child.on("exit", (code, signal) => {
  if (hasPlaywrightConfig("playwright.ui-smoke.config.ts")) {
    cleanupUiSmokeStateDirsForRun();
  }
  releaseLocks();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

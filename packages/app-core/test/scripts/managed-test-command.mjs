import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
const HEARTBEAT_INTERVAL_MS = 5_000;

const REPO_TEST_PROCESS_MARKERS = [
  "node_modules/.bin/vitest run --config vitest.config.ts",
  "test/scripts/test-runner.mjs",
  "test/scripts/test-root-unit.mjs",
  "bun run test",
  "bun run test:integration",
  "bun run test:e2e",
  "bun run test:e2e:all",
  "bun run test:orchestrator:integration",
];

let cachedCloudApiKey;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveSavedCloudApiKey() {
  if (cachedCloudApiKey !== undefined) {
    return cachedCloudApiKey;
  }

  const homeDir =
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    process.env.HOMEDRIVE?.trim();
  if (!homeDir) {
    cachedCloudApiKey = null;
    return cachedCloudApiKey;
  }

  for (const candidate of [
    path.join(homeDir, ".eliza", "eliza.json"),
    path.join(homeDir, ".eliza", "eliza.json"),
  ]) {
    const config = readJson(candidate);
    const apiKey = config?.cloud?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim()) {
      cachedCloudApiKey = apiKey.trim();
      return cachedCloudApiKey;
    }
  }

  cachedCloudApiKey = null;
  return cachedCloudApiKey;
}

function isRealNodeExecutable(candidate) {
  if (!candidate || !fs.existsSync(candidate)) {
    return false;
  }
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) {
    return false;
  }
  const normalized = candidate.replace(/\\/g, "/");
  return !/\/bun-node-[^/]+\/node$/.test(normalized);
}

export function resolveNodeCmd() {
  if (isRealNodeExecutable(process.env.npm_node_execpath)) {
    return process.env.npm_node_execpath;
  }
  for (const candidate of [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ]) {
    if (isRealNodeExecutable(candidate)) {
      return candidate;
    }
  }
  if (isRealNodeExecutable(process.execPath)) {
    return process.execPath;
  }
  return "node";
}

export function buildTestEnv(cwd) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key === "INIT_CWD") {
      delete env[key];
    }
  }
  env.NODE_NO_WARNINGS = env.NODE_NO_WARNINGS || "1";
  env.ELIZA_LIVE_TEST = env.ELIZA_LIVE_TEST || "0";
  env.ELIZA_LIVE_TEST = "0";
  env.PWD = path.resolve(cwd);
  if (!env.ELIZAOS_CLOUD_API_KEY) {
    const savedCloudApiKey = resolveSavedCloudApiKey();
    if (savedCloudApiKey) {
      env.ELIZAOS_CLOUD_API_KEY = savedCloudApiKey;
    }
  }
  return env;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listSystemProcesses() {
  if (process.platform === "win32") {
    return [];
  }

  let output = "";
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)$/);
      if (!match) {
        return null;
      }
      const pid = Number.parseInt(match[1], 10);
      const ppid = Number.parseInt(match[2], 10);
      if (!pid || !ppid) {
        return null;
      }
      return { pid, ppid };
    })
    .filter((entry) => entry !== null);
}

function collectDescendantPids(rootPid) {
  const descendants = [];
  const queue = [rootPid];
  const processTable = listSystemProcesses();

  while (queue.length > 0) {
    const currentPid = queue.shift();
    if (!currentPid) {
      continue;
    }
    for (const entry of processTable) {
      if (entry.ppid !== currentPid || descendants.includes(entry.pid)) {
        continue;
      }
      descendants.push(entry.pid);
      queue.push(entry.pid);
    }
  }

  return descendants;
}

async function waitForProcessesExit(pids, timeoutMs) {
  const uniquePids = [
    ...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0)),
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (uniquePids.every((pid) => !isPidAlive(pid))) {
      return true;
    }
    await sleep(100);
  }
  return uniquePids.every((pid) => !isPidAlive(pid));
}

async function killProcessTree(pid) {
  if (!isPidAlive(pid)) {
    return;
  }

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      // Best effort.
    }
    return;
  }

  const descendants = collectDescendantPids(pid);
  for (const childPid of [...descendants].reverse()) {
    try {
      process.kill(childPid, "SIGTERM");
    } catch {
      // Best effort.
    }
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  if (await waitForProcessesExit([pid, ...descendants], 5_000)) {
    return;
  }

  for (const childPid of [...descendants].reverse()) {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // Best effort.
    }
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best effort.
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readLock(lockPath) {
  if (!fs.existsSync(lockPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function writeLock(lockPath, state) {
  ensureDir(path.dirname(lockPath));
  fs.writeFileSync(lockPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function removeLock(lockPath) {
  fs.rmSync(lockPath, { force: true });
}

function listLockFiles(lockDir) {
  if (!fs.existsSync(lockDir)) {
    return [];
  }
  return fs
    .readdirSync(lockDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => path.join(lockDir, entry));
}

function parseLockPid(value) {
  return Number.isInteger(value)
    ? value
    : Number.parseInt(String(value ?? ""), 10);
}

async function cleanupStaleLock(lockPath) {
  const existing = readLock(lockPath);
  if (!existing) {
    removeLock(lockPath);
    return;
  }

  const ownerPid = parseLockPid(existing.ownerPid);
  const childPid = parseLockPid(existing.childPid);

  if (ownerPid && isPidAlive(ownerPid)) {
    throw new Error(
      `[test-runner] Another "${existing.lockName ?? path.basename(lockPath)}" run is already active (pid ${ownerPid}).`,
    );
  }

  if (childPid && isPidAlive(childPid)) {
    await killProcessTree(childPid);
  }

  removeLock(lockPath);
}

function isAncestorPid(candidatePid) {
  let pid = process.ppid;
  const visited = new Set();
  while (Number.isInteger(pid) && pid > 1 && !visited.has(pid)) {
    if (pid === candidatePid) return true;
    visited.add(pid);
    try {
      const stat = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      pid = Number.parseInt(stat, 10);
    } catch {
      break;
    }
  }
  return false;
}

async function cleanupOtherLockFiles(lockDir, currentLockPath) {
  const activeLocks = [];

  for (const lockPath of listLockFiles(lockDir)) {
    if (lockPath === currentLockPath) {
      continue;
    }

    const existing = readLock(lockPath);
    if (!existing) {
      removeLock(lockPath);
      continue;
    }

    const ownerPid = parseLockPid(existing.ownerPid);
    const childPid = parseLockPid(existing.childPid);

    if (ownerPid && isPidAlive(ownerPid)) {
      // Skip locks held by this process or its ancestors (e.g. parent test-runner)
      if (ownerPid === process.pid || isAncestorPid(ownerPid)) {
        continue;
      }
      activeLocks.push({
        lockName: existing.lockName ?? path.basename(lockPath, ".json"),
        ownerPid,
      });
      continue;
    }

    if (childPid && isPidAlive(childPid)) {
      await killProcessTree(childPid);
    }

    removeLock(lockPath);
  }

  if (activeLocks.length > 0) {
    const summary = activeLocks
      .map((entry) => `"${entry.lockName}" (pid ${entry.ownerPid})`)
      .join(", ");
    throw new Error(
      `[test-runner] Another managed test run is already active: ${summary}.`,
    );
  }
}

function listRepoProcessTable(repoRoot) {
  if (process.platform === "win32") {
    return new Map();
  }

  let output = "";
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return new Map();
  }

  const processTable = new Map();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const command = match[3] ?? "";
    if (!pid || !ppid || !command.includes(repoRoot)) {
      continue;
    }
    processTable.set(pid, { pid, ppid, command });
  }
  return processTable;
}

function listRepoTestProcesses(repoRoot) {
  const processTable = listRepoProcessTable(repoRoot);
  return [...processTable.values()].filter((entry) =>
    REPO_TEST_PROCESS_MARKERS.some((marker) => entry.command.includes(marker)),
  );
}

function collectProcessLineage(pid, processTable) {
  const lineage = new Set();
  let currentPid = pid;

  while (
    Number.isInteger(currentPid) &&
    currentPid > 0 &&
    !lineage.has(currentPid)
  ) {
    lineage.add(currentPid);
    const current = processTable.get(currentPid);
    if (!current || current.ppid === currentPid) {
      break;
    }
    currentPid = current.ppid;
  }

  return lineage;
}

function collectProtectedRepoTestPids(repoRoot) {
  const lockDir = path.join(repoRoot, ".tmp", "test-runner");
  const processTable = listRepoProcessTable(repoRoot);
  const protectedPids = collectProcessLineage(process.pid, processTable);

  for (const lockPath of listLockFiles(lockDir)) {
    const lockState = readLock(lockPath);
    if (!lockState) {
      continue;
    }
    for (const candidatePid of [lockState.ownerPid, lockState.childPid]) {
      const pid = Number.isInteger(candidatePid)
        ? candidatePid
        : Number.parseInt(String(candidatePid ?? ""), 10);
      if (!pid || !isPidAlive(pid)) {
        continue;
      }
      for (const protectedPid of collectProcessLineage(pid, processTable)) {
        protectedPids.add(protectedPid);
      }
    }
  }

  return protectedPids;
}

function hasAncestorManagedLock(lockDir, currentLockPath) {
  for (const lockPath of listLockFiles(lockDir)) {
    if (lockPath === currentLockPath) {
      continue;
    }

    const existing = readLock(lockPath);
    if (!existing) {
      continue;
    }

    for (const candidatePid of [existing.ownerPid, existing.childPid]) {
      const pid = parseLockPid(candidatePid);
      if (pid && isPidAlive(pid) && isAncestorPid(pid)) {
        return true;
      }
    }
  }

  return false;
}

async function cleanupOrphanedRepoTestProcesses(repoRoot) {
  const candidates = listRepoTestProcesses(repoRoot);
  const protectedPids = collectProtectedRepoTestPids(repoRoot);
  const killed = [];

  for (const candidate of candidates) {
    if (protectedPids.has(candidate.pid)) {
      continue;
    }
    await killProcessTree(candidate.pid);
    killed.push(candidate);
  }

  if (killed.length > 0) {
    console.log(
      `[test-runner] cleaned ${killed.length} orphaned repo test process${killed.length === 1 ? "" : "es"}`,
    );
  }
}

export async function runManagedTestCommand({
  repoRoot,
  lockName,
  label,
  command,
  args,
  cwd = repoRoot,
  env = buildTestEnv(cwd),
}) {
  const lockPath = path.join(
    repoRoot,
    ".tmp",
    "test-runner",
    `${lockName}.json`,
  );
  const lockDir = path.dirname(lockPath);
  await cleanupOtherLockFiles(lockDir, lockPath);
  if (!hasAncestorManagedLock(lockDir, lockPath)) {
    await cleanupOrphanedRepoTestProcesses(repoRoot);
  }
  await cleanupStaleLock(lockPath);

  const initialState = {
    lockName,
    label,
    ownerPid: process.pid,
    childPid: null,
    startedAt: new Date().toISOString(),
    cwd: path.resolve(cwd),
    command,
    args,
  };
  writeLock(lockPath, initialState);

  const startedAt = Date.now();
  console.log(`[test-runner] START ${label}: ${[command, ...args].join(" ")}`);

  let child = null;
  let shuttingDown = false;
  let heartbeatTimer = null;

  const cleanup = async (reason = "cleanup") => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (child?.pid) {
      await killProcessTree(child.pid);
    }
    removeLock(lockPath);
    if (reason !== "normal") {
      console.error(`[test-runner] STOP ${label}: ${reason}`);
    }
  };

  const signalHandlers = new Map();
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    const handler = () => {
      void cleanup(`received ${signal}`).finally(() => {
        process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
      });
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    await new Promise((resolve, reject) => {
      // shell: false ensures command + args are passed directly to execvp()
      // with no shell expansion — callers supply a fixed command (e.g. "bun")
      // and a static args array, so there is no shell injection risk here.
      // lgtm[js/shell-command-injection-from-environment]
      child = spawn(command, args, {
        cwd,
        env,
        stdio: "inherit",
        shell: false,
      });

      heartbeatTimer = setInterval(() => {
        console.log(
          `[test-runner] HEARTBEAT ${label} (${Date.now() - startedAt}ms)`,
        );
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();

      writeLock(lockPath, {
        ...initialState,
        childPid: child.pid ?? null,
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("exit", (code, signal) => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const suffix =
          signal != null
            ? `signal ${signal}`
            : `exit code ${code ?? "unknown"}`;
        reject(new Error(`[test-runner] ${label} failed with ${suffix}`));
      });
    });

    console.log(`[test-runner] PASS ${label} (${Date.now() - startedAt}ms)`);
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    await cleanup("normal");
  }
}

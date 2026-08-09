#!/usr/bin/env node
/**
 * Runs the cloud API e2e suite (packages/cloud/api/test/e2e) — wired as
 * `test:cloud:integration` at the repo root. Splits test files into db-only
 * and server-backed lanes, gives known-interfering files isolated bun
 * invocations, and supplies the local test-auth secrets and port config the
 * suite expects.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const cloudApiRoot = path.join(repoRoot, "packages/cloud/api");
const integrationRoot = path.join(repoRoot, "packages/cloud/api/test/e2e");
const testCwd = path.join(repoRoot, ".tmp/cloud-integration-bun");
const bun = process.env.BUN || process.env.npm_execpath || "bun";

const preloadPath = path.join(integrationRoot, "preload.ts");
const serverPreload = preloadPath;
const dbPreload = preloadPath;
const timeoutMs = process.env.CLOUD_INTEGRATION_TIMEOUT_MS || "120000";

/**
 * Reserve an OS-assigned free port. Shared self-hosted runners host several
 * concurrent jobs on one machine; a fixed 8787 meant this runner could adopt a
 * DIFFERENT job's wrangler as "its" healthy server (its own wrangler then died
 * with EADDRINUSE), and the suite collapsed mid-run when that foreign job
 * finished and tore its server down. Only used when the caller did not pin a
 * port or target URL.
 */
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(String(port)));
    });
  });
}

const callerPinnedTarget = Boolean(
  process.env.API_DEV_PORT ||
    process.env.TEST_API_BASE_URL?.trim() ||
    process.env.TEST_BASE_URL?.trim(),
);
const apiPort = callerPinnedTarget
  ? process.env.API_DEV_PORT || "8787"
  : await reserveFreePort();
const baseUrl =
  process.env.TEST_API_BASE_URL?.trim() ||
  process.env.TEST_BASE_URL?.trim() ||
  `http://localhost:${apiPort}`;
const integrationEnv = {
  ...process.env,
  API_DEV_PORT: apiPort,
  TEST_API_BASE_URL: baseUrl,
  TEST_BASE_URL: baseUrl,
  TEST_SERVER_SCRIPT: process.env.TEST_SERVER_SCRIPT || "dev",
  PLAYWRIGHT_TEST_AUTH: process.env.PLAYWRIGHT_TEST_AUTH || "true",
  PLAYWRIGHT_TEST_AUTH_SECRET:
    process.env.PLAYWRIGHT_TEST_AUTH_SECRET || "playwright-local-auth-secret",
  AGENT_TEST_BOOTSTRAP_ADMIN: process.env.AGENT_TEST_BOOTSTRAP_ADMIN || "true",
  PAYOUT_STATUS_SKIP_LIVE_BALANCE:
    process.env.PAYOUT_STATUS_SKIP_LIVE_BALANCE || "1",
  CRON_SECRET: process.env.CRON_SECRET || "test-cron-secret",
  INTERNAL_SECRET: process.env.INTERNAL_SECRET || "test-internal-secret",
};

const isolatedServerFiles = new Set([
  "packages/cloud/api/test/e2e/agent-token-flow.test.ts",
  "packages/cloud/api/test/e2e/group-j-documents.test.ts",
]);
const isolatedDbFiles = new Set([]);

fs.mkdirSync(testCwd, { recursive: true });
fs.writeFileSync(
  path.join(testCwd, "bunfig.toml"),
  "[test]\ntimeout = 60000\ncoverage = false\n",
);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path.relative(repoRoot, fullPath));
    }
  }
  return files.sort();
}

function isDbOnlyFile(file) {
  return (
    file.includes("/db/") ||
    file.includes("/financial/") ||
    file.includes("/services/")
  );
}

function run(label, preload, files) {
  if (files.length === 0) {
    return;
  }

  console.log(
    `[cloud-integration] START ${label} (${files.length} file${files.length === 1 ? "" : "s"})`,
  );
  const result = spawnSync(
    bun,
    [
      "test",
      "--max-concurrency=1",
      "--preload",
      preload,
      ...files.map((file) => path.join(repoRoot, file)),
      "--timeout",
      timeoutMs,
    ],
    {
      cwd: testCwd,
      env: integrationEnv,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  console.log(`[cloud-integration] PASS ${label}`);
}

async function isServerHealthy() {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `[cloud-integration] API server exited before becoming healthy (code ${child.exitCode})`,
      );
    }
    if (await isServerHealthy()) {
      // A health 200 alone is not proof OUR server answered it: a zombie
      // process from a previous run can hold the port, answer health, and
      // then die mid-suite while our wrangler exits with EADDRINUSE. Only
      // accept health responses while our child is still alive.
      if (child.exitCode !== null) {
        throw new Error(
          `[cloud-integration] API server exited (code ${child.exitCode}) but ${baseUrl} still answers health — a stale process holds port ${apiPort}. Kill it and retry.`,
        );
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    "[cloud-integration] Timed out waiting for API server health",
  );
}

function isPortOccupied(port) {
  const lsof = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  return lsof.status === 0 && lsof.stdout.trim().length > 0;
}

async function ensureServer() {
  if (process.env.REQUIRE_E2E_SERVER === "0") {
    return null;
  }
  if (await isServerHealthy()) {
    return null;
  }
  if (process.env.TEST_API_BASE_URL || process.env.TEST_BASE_URL) {
    throw new Error("[cloud-integration] Configured API server is not healthy");
  }
  if (isPortOccupied(apiPort)) {
    throw new Error(
      `[cloud-integration] Port ${apiPort} is already bound by a process that does not answer ${baseUrl}/api/health — a stale server from a previous run is holding the port. Kill it and retry.`,
    );
  }

  console.log(`[cloud-integration] START API dev server at ${baseUrl}`);
  const child = spawn(bun, ["run", integrationEnv.TEST_SERVER_SCRIPT], {
    cwd: cloudApiRoot,
    env: integrationEnv,
    stdio: "inherit",
  });
  await waitForServer(child);
  return child;
}

function stopServer(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
}

const allFiles = walk(integrationRoot);
const serverFiles = allFiles.filter(
  (file) =>
    !isDbOnlyFile(file) &&
    !isolatedServerFiles.has(file) &&
    !isolatedDbFiles.has(file),
);
const dbFiles = allFiles.filter(
  (file) =>
    isDbOnlyFile(file) &&
    !isolatedServerFiles.has(file) &&
    !isolatedDbFiles.has(file),
);

const server = await ensureServer();
try {
  run("server-backed integration", serverPreload, serverFiles);
  for (const file of isolatedServerFiles) {
    run(file, serverPreload, [file]);
  }
} finally {
  stopServer(server);
}
run("db/service integration", dbPreload, dbFiles);
for (const file of isolatedDbFiles) {
  run(file, dbPreload, [file]);
}

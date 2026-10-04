// Exercises cloud API test e2e run e2e batches behavior with deterministic Worker route fixtures.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommandWithWatchdog } from "../../../../scripts/test-cloud-run.ts";
import {
  acquirePortLease,
  cleanupRunContext,
  createIsolatedRunState,
  createOwnedChildRegistry,
  installSignalTeardown,
  spawnOwnedChild,
  startOwnedPGlite,
  stopOwnedChild,
} from "../../../scripts/admin/integration-harness-lifecycle.ts";
import { createE2eDatabaseStore } from "../../../scripts/api/e2e-database-store.ts";
import { waitForWorkerHealth } from "./_helpers/worker-health.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDir, "..", "..");
const repoRoot = join(appRoot, "..", "..", "..");
const cloudSharedRoot = join(repoRoot, "packages", "cloud", "shared");
const bun = process.env.BUN || process.env.npm_execpath || "bun";
const extraArgs = process.argv.slice(2);

// Explicit ports are leased or rejected; automatic ports are collision checked.
let apiPort = process.env.API_DEV_PORT || "41000";
const configuredBaseUrl =
  process.env.TEST_API_BASE_URL || process.env.TEST_BASE_URL || "";
let baseUrl = configuredBaseUrl || `http://localhost:${apiPort}`;
const ownsLocalServer =
  process.env.REQUIRE_E2E_SERVER !== "0" && !configuredBaseUrl;
const e2eRunReceipt =
  process.env.CLOUD_E2E_RUN_RECEIPT || (ownsLocalServer ? randomUUID() : "");
const configuredDatabaseUrl =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
let pglitePort = process.env.TEST_PGLITE_PORT || "46000";
const pgliteHost = process.env.PGLITE_HOST || "127.0.0.1";
let databaseStore;
let runContext;
const children = createOwnedChildRegistry();
let teardownPromise;
function teardown() {
  return (teardownPromise ??= (async () => {
    await children.stopAll();
    databaseStore?.cleanup();
    cleanupRunContext(runContext);
  })());
}
const pgliteMaxConnections =
  process.env.TEST_PGLITE_MAX_CONNECTIONS ||
  process.env.PGLITE_MAX_CONNECTIONS ||
  "16";
let databaseUrl =
  configuredDatabaseUrl ||
  `postgresql://postgres@${pgliteHost}:${pglitePort}/postgres`;
const e2eEnv = {
  ...process.env,
  API_DEV_PORT: apiPort,
  DATABASE_URL: databaseUrl,
  TEST_DATABASE_URL: databaseUrl,
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
  // Force the in-memory KMS adapter for e2e. wrangler.toml's [vars] block
  // hard-codes NODE_ENV=production which would otherwise win over the
  // workflow-level NODE_ENV=test and cause routes that touch encrypted
  // fields to throw KmsError. The cloud-api-dev wrapper also passes this
  // via `wrangler --var`, but mirror it here so any harness that bypasses
  // the wrapper still gets a working KMS.
  NODE_ENV: process.env.NODE_ENV || "test",
  CLOUD_E2E: process.env.CLOUD_E2E || "1",
  // Paid voice-provider admission requires an atomic Redis implementation.
  // The local workerd lane has no external Redis binding, so opt it into the
  // repository's explicit Lua-capable in-memory test backend. Without this,
  // the real WebSocket route correctly fails closed with HTTP 503 before the
  // binary-first middleware contract can exercise the 101 upgrade.
  MOCK_REDIS: process.env.MOCK_REDIS || "1",
  // The local admission caches are part of the real Worker contract. Force
  // them on with the in-memory backend so an ambient CACHE_ENABLED=false does
  // not make provider-backed tests permanently fail before they can hydrate.
  CACHE_ENABLED: "true",
  ...(e2eRunReceipt ? { CLOUD_E2E_RUN_RECEIPT: e2eRunReceipt } : {}),
  ELIZA_KMS_BACKEND: process.env.ELIZA_KMS_BACKEND || "memory",
  // Keep the real voice upgrade route reachable in the pinned-Workerd lane.
  // Binary-first coverage closes before token verification, so these inert
  // values never open an outbound provider connection.
  VOICE_REALTIME_WS_ENABLED: process.env.VOICE_REALTIME_WS_ENABLED || "true",
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || "e2e-inert-deepgram",
  CARTESIA_API_KEY: process.env.CARTESIA_API_KEY || "e2e-inert-cartesia",
  VOICE_REALTIME_CARTESIA_VOICE_ID:
    process.env.VOICE_REALTIME_CARTESIA_VOICE_ID || "e2e-inert-voice",
  VOICE_REALTIME_ELIZA_ENDPOINT:
    process.env.VOICE_REALTIME_ELIZA_ENDPOINT ||
    "https://voice-e2e.invalid/sse",
  VOICE_REALTIME_ELIZA_AUTHORIZATION:
    process.env.VOICE_REALTIME_ELIZA_AUTHORIZATION || "Bearer e2e-inert",
};

async function isHealthy(serverPid) {
  try {
    await waitForWorkerHealth({
      baseUrl,
      expectedReceipt: e2eRunReceipt || undefined,
      serverPid,
      timeoutMs: 1_000,
      attemptTimeoutMs: 750,
      retryIntervalMs: 100,
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(processRef) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (processRef.exitCode !== null) {
      throw new Error(
        `[api-e2e] dev server exited before becoming healthy (code ${processRef.exitCode})`,
      );
    }
    if (await isHealthy(processRef.pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`[api-e2e] timed out waiting for ${baseUrl}/api/health`);
}

function parsePGliteDataDir(url) {
  if (!url?.startsWith("pglite://")) return null;
  const dataDir = url.slice("pglite://".length);
  if (!dataDir || dataDir === "memory") return null;
  return dataDir;
}

function listenerPidsOnPort(port) {
  const lsof = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  if (lsof.status === 0 && lsof.stdout.trim()) {
    return lsof.stdout.match(/\b\d+\b/g) ?? [];
  }
  const fuser = spawnSync("fuser", [`${port}/tcp`], { encoding: "utf8" });
  if (fuser.status !== 0) return [];
  const fuserOut = `${fuser.stdout ?? ""} ${fuser.stderr ?? ""}`.trim();
  return fuserOut.match(/\b\d+\b/g) ?? [];
}

async function ensurePGliteBridge() {
  const usingPGliteBridge =
    !configuredDatabaseUrl || configuredDatabaseUrl.startsWith("pglite://");
  if (!usingPGliteBridge) return null;

  databaseStore = createE2eDatabaseStore({
    root: repoRoot,
    directory:
      parsePGliteDataDir(configuredDatabaseUrl) ||
      process.env.TEST_PGLITE_DATA_DIR,
    persistent: process.env.TEST_PGLITE_PERSIST === "1",
  });
  const dataDir = databaseStore.directory;

  console.log(
    `[api-e2e] START PGlite TCP server at ${pgliteHost}:${pglitePort}`,
  );
  return startOwnedPGlite(
    {
      ...runContext,
      host: pgliteHost,
      pglitePort: Number(pglitePort),
      pgliteDataDir: dataDir,
    },
    {
      bun,
      repoRoot,
      env: { ...e2eEnv, PGLITE_MAX_CONNECTIONS: pgliteMaxConnections },
      signal: children.signal,
      onSpawn: (child) => children.publish("PGlite", child),
    },
  );
}

async function ensureServer() {
  if (process.env.REQUIRE_E2E_SERVER === "0") return null;
  if (configuredBaseUrl) {
    if (await isHealthy()) return null;
    throw new Error(`[api-e2e] configured server is not healthy: ${baseUrl}`);
  }

  const existingListeners = listenerPidsOnPort(apiPort);
  if (existingListeners.length > 0) {
    throw new Error(
      `[api-e2e] refusing pre-existing listener(s) on owned API port ${apiPort}: ${existingListeners.join(",")}`,
    );
  }

  console.log(`[api-e2e] START dev server at ${baseUrl}`);
  children.signal.throwIfAborted();
  const child = spawnOwnedChild(
    bun,
    ["run", process.env.TEST_SERVER_SCRIPT || "dev"],
    {
      cwd: appRoot,
      stdio: "inherit",
      env: e2eEnv,
    },
  );
  try {
    if (!children.publish("API", child)) children.signal.throwIfAborted();
    await once(child, "spawn");
    await waitForHealth(child);
    return child;
  } catch (error) {
    await stopOwnedChild(child, "API");
    throw error;
  }
}

async function runBounded(commandArgs, cwd) {
  const result = await runCommandWithWatchdog(bun, commandArgs, {
    cwd,
    env: e2eEnv,
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
  if (result.error) throw result.error;
  if (result.terminationError) throw result.terminationError;
  if (result.timedOut || result.parentSignal)
    throw new Error("[api-e2e] child interrupted or timed out");
  return result;
}

async function ensureDatabase() {
  const result = await runBounded(
    ["run", "db:migrate:drizzle"],
    cloudSharedRoot,
  );
  if (result.status !== 0)
    throw new Error(
      `[api-e2e] database migration failed with exit code ${result.status ?? "unknown"}`,
    );
}

const onlyFilter = (process.env.E2E_ONLY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .filter(
    (name) =>
      onlyFilter.length === 0 || onlyFilter.some((f) => name.includes(f)),
  )
  .sort()
  .map((name) => relative(appRoot, join(testDir, name)));

if (testFiles.length === 0) throw new Error("[api-e2e] no test files matched");
const removeSignalHandlers = installSignalTeardown(teardown);
try {
  runContext = createIsolatedRunState();
  if (ownsLocalServer) {
    runContext.apiLease = await acquirePortLease({
      runId: runContext.runId,
      label: "API",
      preferredPort: process.env.API_DEV_PORT,
    });
    apiPort = String(runContext.apiLease.port);
    baseUrl = `http://127.0.0.1:${apiPort}`;
  }
  if (!configuredDatabaseUrl || configuredDatabaseUrl.startsWith("pglite://")) {
    runContext.pgliteLease = await acquirePortLease({
      runId: runContext.runId,
      label: "PGlite",
      preferredPort: process.env.TEST_PGLITE_PORT,
      host: pgliteHost,
    });
    pglitePort = String(runContext.pgliteLease.port);
    databaseUrl = `postgresql://postgres@${pgliteHost}:${pglitePort}/postgres`;
  }
  Object.assign(e2eEnv, {
    API_DEV_PORT: apiPort,
    TEST_API_BASE_URL: baseUrl,
    TEST_BASE_URL: baseUrl,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    ELIZA_API_DEV_VARS_PATH: runContext.devVarsPath,
    DEV_CLOUD_WRANGLER_PERSIST_TO: runContext.wranglerPersistPath,
    WRANGLER_CACHE_DIR: runContext.wranglerCachePath,
    WRANGLER_LOG_PATH: runContext.wranglerLogPath,
    MINIFLARE_CACHE_DIR: runContext.miniflareCachePath,
    ELIZA_STATE_DIR: runContext.stateDir,
  });
  await ensurePGliteBridge();
  await ensureDatabase();
  const server = await ensureServer();
  if (server?.pid) {
    e2eEnv.CLOUD_E2E_SERVER_PID = String(server.pid);
    const listenerPids = listenerPidsOnPort(apiPort);
    console.log(
      `[api-e2e] OWNED Worker wrapper pid=${server.pid} listener pid=${listenerPids.join(",") || "unknown"} port=${apiPort} receipt=${e2eRunReceipt}`,
    );
  }
  for (const testFile of testFiles) {
    console.log(`[api-e2e] START ${testFile}`);
    const result = await runBounded(
      [
        "test",
        "--max-concurrency=1",
        "--preload",
        "./test/e2e/preload.ts",
        testFile,
        "--timeout",
        "120000",
        ...extraArgs,
      ],
      appRoot,
    );

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      console.error(`[api-e2e] FAIL ${testFile}`);
      process.exitCode = result.status ?? 1;
      break;
    }
    console.log(`[api-e2e] PASS ${testFile}`);
  }
} finally {
  try {
    await teardown();
  } finally {
    removeSignalHandlers();
  }
}

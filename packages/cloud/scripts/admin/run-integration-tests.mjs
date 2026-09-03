#!/usr/bin/env node
/**
 * Runs the cloud API integration suite against either a fully owned local
 * Worker/PGlite pair or an explicitly configured external Worker. Managed
 * runs isolate every socket and mutable state directory, and retain child
 * handles so teardown can never adopt or terminate another run's processes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupRunContext,
  createIsolatedRunState,
  createManagedRunContext,
  createOwnedChildRegistry,
  externalApiHealthy,
  installSignalTeardown,
  spawnOwnedChild,
  startOwnedApi,
  startOwnedPGlite,
  stopOwnedChild,
  withPreservedTeardown,
} from "./integration-harness-lifecycle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const cloudApiRoot = path.join(repoRoot, "packages/cloud/api");
const integrationRoot = path.join(repoRoot, "packages/cloud/api/test/e2e");
const bun = process.env.BUN || process.env.npm_execpath || "bun";

const preloadPath = path.join(integrationRoot, "preload.ts");
const timeoutMs = process.env.CLOUD_INTEGRATION_TIMEOUT_MS || "120000";
const isolatedServerFiles = new Set([
  "packages/cloud/api/test/e2e/agent-token-flow.test.ts",
  "packages/cloud/api/test/e2e/group-j-documents.test.ts",
]);
const isolatedDbFiles = new Set();

class IntegrationBatchError extends Error {
  constructor(label, exitCode, signal) {
    super(
      `[cloud-integration] ${label} failed (${signal ? `signal ${signal}` : `exit ${exitCode}`})`,
    );
    this.name = "IntegrationBatchError";
    this.exitCode = exitCode || 1;
  }
}

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

function writeBunfig(testCwd) {
  fs.writeFileSync(
    path.join(testCwd, "bunfig.toml"),
    "[test]\ntimeout = 60000\ncoverage = false\n",
  );
}

function configuredExternalBaseUrl() {
  return (
    process.env.TEST_API_BASE_URL?.trim() ||
    process.env.TEST_BASE_URL?.trim() ||
    null
  );
}

function configuredExternalDatabaseUrl() {
  return (
    process.env.TEST_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    null
  );
}

function buildIntegrationEnv({ context, baseUrl, databaseUrl }) {
  return {
    ...process.env,
    NODE_ENV: "test",
    CLOUD_E2E: "1",
    ...(context.apiPort ? { API_DEV_PORT: String(context.apiPort) } : {}),
    TEST_API_BASE_URL: baseUrl,
    TEST_BASE_URL: baseUrl,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    TEST_SERVER_SCRIPT: process.env.TEST_SERVER_SCRIPT || "dev",
    PLAYWRIGHT_TEST_AUTH: process.env.PLAYWRIGHT_TEST_AUTH || "true",
    PLAYWRIGHT_TEST_AUTH_SECRET:
      process.env.PLAYWRIGHT_TEST_AUTH_SECRET || "playwright-local-auth-secret",
    AGENT_TEST_BOOTSTRAP_ADMIN:
      process.env.AGENT_TEST_BOOTSTRAP_ADMIN || "true",
    PAYOUT_STATUS_SKIP_LIVE_BALANCE:
      process.env.PAYOUT_STATUS_SKIP_LIVE_BALANCE || "1",
    CRON_SECRET: process.env.CRON_SECRET || "test-cron-secret",
    INTERNAL_SECRET: process.env.INTERNAL_SECRET || "test-internal-secret",
    // Wallet-signature authentication uses an atomic consume-once nonce. The
    // isolated local Worker lane uses the repository's explicit test backend.
    MOCK_REDIS: process.env.MOCK_REDIS || "1",
    // This suite deliberately exercises cache-backed authentication even when
    // a workflow-level default disables optional caches.
    CACHE_ENABLED: "true",
    ELIZA_CLOUD_LOCAL_API_URL: baseUrl,
    ELIZA_API_DEV_VARS_PATH: context.devVarsPath,
    DEV_CLOUD_WRANGLER_PERSIST_TO: context.wranglerPersistPath,
    WRANGLER_CACHE_DIR: context.wranglerCachePath,
    WRANGLER_LOG_PATH: context.wranglerLogPath,
    WRANGLER_SEND_METRICS: "false",
    MINIFLARE_CACHE_DIR: context.miniflareCachePath,
    ELIZA_STATE_DIR: context.stateDir,
    TMPDIR: context.tempDir,
    TMP: context.tempDir,
    TEMP: context.tempDir,
    CLOUD_INTEGRATION_RUN_ID: context.runId,
  };
}

async function runBatch({
  label,
  files,
  testCwd,
  integrationEnv,
  childRegistry,
}) {
  if (files.length === 0) return;

  console.log(
    `[cloud-integration] START ${label} (${files.length} file${files.length === 1 ? "" : "s"})`,
  );
  const child = spawnOwnedChild(
    bun,
    [
      "test",
      "--max-concurrency=1",
      "--preload",
      preloadPath,
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
  if (!childRegistry.publish(`integration test batch: ${label}`, child)) {
    await stopOwnedChild(child, "cancelled integration test batch");
    throw childRegistry.signal.reason;
  }

  await withPreservedTeardown(
    async () => {
      const { code, signal } = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      if (code !== 0) throw new IntegrationBatchError(label, code, signal);
      console.log(`[cloud-integration] PASS ${label}`);
    },
    async () => {
      await stopOwnedChild(child, "integration test batch");
      childRegistry.forget(child);
    },
  );
}

export async function main() {
  const externalBaseUrl = configuredExternalBaseUrl();
  const requiresServer = process.env.REQUIRE_E2E_SERVER !== "0";
  const managed = !externalBaseUrl;
  const context = managed
    ? await createManagedRunContext({
        apiPort: process.env.CLOUD_INTEGRATION_API_PORT,
        pglitePort: process.env.CLOUD_INTEGRATION_PGLITE_PORT,
      })
    : createIsolatedRunState();
  const baseUrl = managed
    ? context.baseUrl
    : (externalBaseUrl ?? "http://127.0.0.1:8787");
  const databaseUrl = managed
    ? context.databaseUrl
    : configuredExternalDatabaseUrl();
  if (!databaseUrl) {
    cleanupRunContext(context);
    throw new Error(
      "[cloud-integration] external mode requires TEST_DATABASE_URL or DATABASE_URL",
    );
  }

  const integrationEnv = buildIntegrationEnv({
    context,
    baseUrl,
    databaseUrl,
  });
  writeBunfig(context.testCwd);

  const childRegistry = createOwnedChildRegistry();
  let teardownPromise = null;
  const teardown = () => {
    teardownPromise ??= (async () => {
      await childRegistry.stopAll();
      cleanupRunContext(context);
    })();
    return teardownPromise;
  };
  const removeSignalHandlers = installSignalTeardown(teardown);

  try {
    await withPreservedTeardown(async () => {
      if (managed) {
        console.log(
          `[cloud-integration] run ${context.runId} owns API ${baseUrl}, PGlite ${context.host}:${context.pglitePort}, and ${context.runRoot}`,
        );
        await startOwnedPGlite(context, {
          bun,
          repoRoot,
          env: {
            ...integrationEnv,
            PGLITE_MAX_CONNECTIONS: process.env.PGLITE_MAX_CONNECTIONS || "64",
          },
          signal: childRegistry.signal,
          onSpawn: (child) => childRegistry.publish("PGlite server", child),
        });
        if (requiresServer) {
          console.log(
            `[cloud-integration] START owned API server at ${baseUrl}`,
          );
          await startOwnedApi(context, {
            bun,
            cloudApiRoot,
            env: integrationEnv,
            testServerScript: integrationEnv.TEST_SERVER_SCRIPT,
            signal: childRegistry.signal,
            onSpawn: (child) => childRegistry.publish("API server", child),
          });
        }
      } else if (requiresServer && !(await externalApiHealthy(baseUrl))) {
        throw new Error(
          `[cloud-integration] configured external API server is not healthy at ${baseUrl}`,
        );
      } else {
        console.log(
          `[cloud-integration] using explicit external API/DB; this run will not stop either service`,
        );
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
      const run = (label, files) =>
        runBatch({
          label,
          files,
          testCwd: context.testCwd,
          integrationEnv,
          childRegistry,
        });

      await run("server-backed integration", serverFiles);
      for (const file of isolatedServerFiles) {
        await run(file, [file]);
      }
      await run("db/service integration", dbFiles);
      for (const file of isolatedDbFiles) {
        await run(file, [file]);
      }
    }, teardown);
  } finally {
    removeSignalHandlers();
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // error-policy:J1 CLI boundary reports failure after owned-state teardown.
    console.error(error);
    process.exitCode = error?.exitCode || 1;
  });
}

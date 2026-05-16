import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDir, "..", "..");
const repoRoot = join(appRoot, "..", "..");
const cloudSharedRoot = join(repoRoot, "packages", "cloud-shared");
const bun = process.env.BUN || process.env.npm_execpath || "bun";
const extraArgs = process.argv.slice(2);
const apiPort = process.env.API_DEV_PORT || "8787";
const baseUrl =
  process.env.TEST_API_BASE_URL ||
  process.env.TEST_BASE_URL ||
  `http://localhost:${apiPort}`;
const databaseUrl =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://eliza_test:test123@localhost:5432/eliza_test";
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
};

async function isHealthy() {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
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
    if (await isHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`[api-e2e] timed out waiting for ${baseUrl}/api/health`);
}

async function ensureServer() {
  if (process.env.REQUIRE_E2E_SERVER === "0") return null;
  if (await isHealthy()) return null;
  if (process.env.TEST_API_BASE_URL || process.env.TEST_BASE_URL) {
    throw new Error(`[api-e2e] configured server is not healthy: ${baseUrl}`);
  }

  console.log(`[api-e2e] START dev server at ${baseUrl}`);
  const child = spawn(bun, ["run", process.env.TEST_SERVER_SCRIPT || "dev"], {
    cwd: appRoot,
    stdio: "inherit",
    env: e2eEnv,
  });
  await waitForHealth(child);
  return child;
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
}

function ensureDatabase() {
  const result = spawnSync(bun, ["run", "db:migrate:drizzle"], {
    cwd: cloudSharedRoot,
    stdio: "inherit",
    env: e2eEnv,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `[api-e2e] database migration failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => relative(appRoot, join(testDir, name)));

ensureDatabase();
const server = await ensureServer();
try {
  for (const testFile of testFiles) {
    console.log(`[api-e2e] START ${testFile}`);
    const result = spawnSync(
      bun,
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
      {
        cwd: appRoot,
        stdio: "inherit",
        env: e2eEnv,
      },
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
  stopServer(server);
}

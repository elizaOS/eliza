const { defineConfig } = require("@playwright/test");
const { config: loadEnvFile } = require("dotenv");
const { applyDatabaseUrlFallback } = require("./packages/db/database-url");

for (const envPath of [
  `${__dirname}/.env`,
  `${__dirname}/.env.local`,
  `${__dirname}/.env.test`,
  `${__dirname}/packages/tests/.env`,
  `${__dirname}/packages/tests/.env.local`,
  `${__dirname}/packages/tests/.env.test`,
]) {
  loadEnvFile({ path: envPath });
}

process.env.NODE_ENV = "test";
process.env.TEST_BLOCK_ANONYMOUS = "true";
process.env.AGENT_TEST_BOOTSTRAP_ADMIN ??= "true";

if (process.env.SKIP_DB_DEPENDENT === "1") {
  delete process.env.DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
} else if (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  process.env.TEST_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
} else {
  applyDatabaseUrlFallback(process.env);
}

const configuredPort = Number.parseInt(process.env.PLAYWRIGHT_PORT ?? "3000", 10);
const PORT = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 3000;
const BASE_URL = `http://localhost:${PORT}`;
const configuredApiPort = Number.parseInt(process.env.PLAYWRIGHT_API_PORT ?? "8787", 10);
const API_PORT =
  Number.isFinite(configuredApiPort) && configuredApiPort > 0 ? configuredApiPort : 8787;
const API_URL = `http://localhost:${API_PORT}`;
const PLAYWRIGHT_WORKERS = Number.parseInt(process.env.PLAYWRIGHT_WORKERS ?? "1", 10);
const STEWARD_TEST_SECRET =
  process.env.STEWARD_SESSION_SECRET ||
  process.env.STEWARD_JWT_SECRET ||
  "playwright-local-steward-secret";
const STEWARD_TEST_TENANT_ID = process.env.STEWARD_TENANT_ID || "elizacloud";

process.env.ELIZAOS_CLOUD_BASE_URL = `${BASE_URL}/api/v1`;

module.exports = defineConfig({
  testDir: "./packages/tests/playwright",
  globalSetup: "./packages/tests/playwright/global-setup.cjs",
  timeout: 30_000,
  fullyParallel: false,
  workers: Number.isFinite(PLAYWRIGHT_WORKERS) && PLAYWRIGHT_WORKERS > 0 ? PLAYWRIGHT_WORKERS : 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
  },
  webServer: {
    command: `concurrently -n api,web -c blue,magenta "PORT=${API_PORT} API_DEV_PORT=${API_PORT} bun run dev:api" "VITE_API_PROXY_TARGET=${API_URL} bun run --cwd apps/frontend dev -- --host 127.0.0.1 --port ${PORT} --strictPort"`,
    url: `${BASE_URL}/api/health`,
    // API on Workers + Vite dev server; health proves the API is reachable (frontend proxies /api in dev).
    timeout: 600_000,
    reuseExistingServer: true,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      API_DEV_PORT: String(API_PORT),
      PLAYWRIGHT_API_URL: API_URL,
      VITE_API_PROXY_TARGET: API_URL,
      REDIS_RATE_LIMITING: "true",
      PLAYWRIGHT_TEST_AUTH: process.env.PLAYWRIGHT_TEST_AUTH ?? "true",
      NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH: process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH ?? "true",
      PLAYWRIGHT_TEST_AUTH_SECRET:
        process.env.PLAYWRIGHT_TEST_AUTH_SECRET ?? "playwright-local-auth-secret",
      AGENT_TEST_BOOTSTRAP_ADMIN: process.env.AGENT_TEST_BOOTSTRAP_ADMIN,
      STEWARD_SESSION_SECRET: STEWARD_TEST_SECRET,
      STEWARD_JWT_SECRET: STEWARD_TEST_SECRET,
      STEWARD_TENANT_ID: STEWARD_TEST_TENANT_ID,
    },
  },
});

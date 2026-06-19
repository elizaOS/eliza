import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");
const apiPort = Number(process.env.ELIZA_HMR_API_PORT || "41337");
const uiPort = Number(process.env.ELIZA_HMR_UI_PORT || "42138");
const stateDir =
  process.env.ELIZA_HMR_STATE_DIR ||
  path.join(os.tmpdir(), `eliza-hmr-${process.pid}`);

process.env.ELIZA_API_PORT = String(apiPort);
process.env.ELIZA_UI_PORT = String(uiPort);
process.env.ELIZA_STATE_DIR = stateDir;

export default defineConfig({
  testDir: "./test/hmr",
  // Vite HMR is independent of the API runtime; this suite must not be gated by
  // agent readiness, so its budget is generous but each test self-times.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  // HMR propagation is timing-sensitive: a module fetch or the Vite socket can
  // occasionally lose the race with the edit. Retry rather than fail the whole
  // (serial) suite on a one-off miss.
  retries: 2,
  workers: 1,
  reporter: "list",
  outputDir: "./test-results/hmr",
  use: {
    baseURL: `http://127.0.0.1:${uiPort}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run dev",
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: "true",
      ELIZA_API_PORT: String(apiPort),
      ELIZA_UI_PORT: String(uiPort),
      ELIZA_PORT: String(uiPort),
      ELIZA_STATE_DIR: stateDir,
      MILADY_STATE_DIR: stateDir,
      ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE || "eliza-hmr",
      // Keep the API process watcher off (HMR under test is Vite's, not the
      // API's), quiet logs, and skip optional camera deps in CI.
      ELIZA_DEV_NO_WATCH: "1",
      ELIZA_DEV_QUIET_LOGS: "1",
      ELIZA_NO_VISION_DEPS: "1",
      // Vite cold-start of the full raw-source module graph exceeds dev-ui's
      // default 60s health-check window on shared CI runners; widen it so the
      // watchdog doesn't SIGTERM Vite before it can serve the HMR client.
      ELIZA_DEV_VITE_READY_BUDGET_MS: "120000",
      FORCE_COLOR: "0",
      NODE_NO_WARNINGS: "1",
    },
    port: uiPort,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

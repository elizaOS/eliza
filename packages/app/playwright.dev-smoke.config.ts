import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");
const apiPort = Number(process.env.ELIZA_DEV_SMOKE_API_PORT || "31337");
const uiPort = Number(process.env.ELIZA_DEV_SMOKE_UI_PORT || "2138");
const stateDir =
  process.env.ELIZA_DEV_SMOKE_STATE_DIR ||
  path.join(os.tmpdir(), `eliza-dev-smoke-${process.pid}`);

process.env.ELIZA_API_PORT = String(apiPort);
process.env.ELIZA_UI_PORT = String(uiPort);
process.env.ELIZA_STATE_DIR = stateDir;
process.env.ELIZA_NAMESPACE = process.env.ELIZA_NAMESPACE || "eliza-dev-smoke";

export default defineConfig({
  testDir: "./test/dev-smoke",
  timeout: 240_000,
  expect: {
    timeout: 20_000,
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "./test-results/dev-smoke",
  use: {
    baseURL: `http://127.0.0.1:${uiPort}`,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun run dev",
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: "true",
      ELIZA_API_PORT: String(apiPort),
      ELIZA_UI_PORT: String(uiPort),
      ELIZA_STATE_DIR: stateDir,
      ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE || "eliza-dev-smoke",
      ELIZA_DEV_NO_WATCH: "1",
      ELIZA_DEV_QUIET_LOGS: "1",
      ELIZA_NO_VISION_DEPS: "1",
      FORCE_COLOR: "0",
      NODE_NO_WARNINGS: "1",
    },
    port: uiPort,
    reuseExistingServer: false,
    timeout: 420_000,
  },
});

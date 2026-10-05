/**
 * Playwright configuration for the development authentication test lane,
 * including browser projects and app-server wiring.
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { testOutputPath } from "../scripts/lib/test-output.ts";
import { resolvePlaywrightPortEnv } from "./scripts/lib/playwright-port.ts";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");
// Fail closed on explicit port typos before baseURL/webServer wiring.
const apiPort = resolvePlaywrightPortEnv(
  process.env,
  "ELIZA_DEV_AUTH_API_PORT",
  31337,
);
const uiPort = resolvePlaywrightPortEnv(
  process.env,
  "ELIZA_DEV_AUTH_UI_PORT",
  2138,
);
const stateDir =
  process.env.ELIZA_DEV_AUTH_STATE_DIR ||
  path.join(os.tmpdir(), `eliza-dev-auth-${process.pid}`);
const cloudOnlyLane = process.env.ELIZA_DEV_AUTH_CLOUD_ONLY === "1";
const stagingLiveAuthLane =
  process.env.ELIZA_DEV_AUTH_STAGING_LIVE_AUTH === "1";

if (Number(cloudOnlyLane) + Number(stagingLiveAuthLane) > 1) {
  throw new Error(
    "ELIZA_DEV_AUTH_CLOUD_ONLY and ELIZA_DEV_AUTH_STAGING_LIVE_AUTH are mutually exclusive",
  );
}

const laneName = cloudOnlyLane
  ? "cloud-only"
  : stagingLiveAuthLane
    ? "staging-live-auth"
    : "staging";

process.env.ELIZA_API_PORT = String(apiPort);
process.env.ELIZA_UI_PORT = String(uiPort);
process.env.ELIZA_STATE_DIR = stateDir;
process.env.ELIZA_NAMESPACE = process.env.ELIZA_NAMESPACE || "eliza-dev-auth";

export default defineConfig({
  testDir: "./test/dev-auth",
  timeout: 600_000,
  expect: {
    timeout: 20_000,
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  // Each authentication mode owns its artifacts.
  // Playwright clears outputDir at invocation start, so each lane owns a
  // directory and cannot erase the previous lane's screenshots/traces.
  outputDir: testOutputPath("app", `dev-auth-${laneName}`),
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
    command: cloudOnlyLane
      ? "bun run --cwd packages/app dev:cloud-only"
      : "bun run dev",
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: "true",
      ELIZA_API_PORT: String(apiPort),
      ELIZA_UI_PORT: String(uiPort),
      ELIZA_STATE_DIR: stateDir,
      ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE || "eliza-dev-auth",
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

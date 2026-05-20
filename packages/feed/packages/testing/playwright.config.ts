/**
 * Playwright configuration for E2E tests.
 *
 * This config is for standard Playwright tests.
 * For Chroma E2E tests, use ../../tools/chroma/playwright.config.ts instead.
 *
 * @module testing/playwright.config
 * @see https://playwright.dev/docs/test-configuration
 */

import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

const rootDir = path.resolve(__dirname, "../..");
dotenv.config({ path: path.resolve(rootDir, ".env.local") });
dotenv.config({ path: path.resolve(rootDir, ".env") });

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3400";
// Ensure all test files see the resolved base URL (prevents NEXT_PUBLIC_APP_URL override)
process.env.PLAYWRIGHT_BASE_URL = baseURL;
const serverURL = new URL(baseURL);
const serverHostname = serverURL.hostname;
const serverPort = serverURL.port || "3400";

export default defineConfig({
  globalSetup:
    process.env.CI || process.env.PLAYWRIGHT_SKIP_WEBSERVER
      ? undefined
      : path.resolve(__dirname, "e2e/global-setup.ts"),
  testDir: "./e2e",

  /* Run tests in files in parallel */
  fullyParallel: false,

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Run tests serially to avoid race conditions */
  workers: 1,

  /* Reporter to use */
  reporter: [["list"]],

  /* Shared settings for all the projects below */
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      args: ["--disable-dev-shm-usage"],
    },
  },

  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      testDir: "./e2e",
    },
    {
      name: "setup-integration-auth",
      testMatch: /.*integration.*\.setup\.ts/,
      testDir: "./integration",
      use: {
        storageState: path.resolve(rootDir, ".playwright/auth.json"),
      },
      dependencies: ["setup"],
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.resolve(rootDir, ".playwright/auth.json"),
      },
      dependencies: ["setup"],
      testIgnore: ["**/*.api.test.ts", "**/*.e2e.test.ts"],
    },
    {
      name: "api-e2e",
      testMatch: ["**/*.e2e.test.ts"],
      use: {
        ...devices["Desktop Chrome"],
      },
      dependencies: ["setup"],
    },
  ],

  webServer:
    process.env.CI || process.env.PLAYWRIGHT_SKIP_WEBSERVER
      ? undefined
      : [
          {
            command: `anvil --host 0.0.0.0 --port 8545 --chain-id 31337`,
            url: "http://127.0.0.1:8545",
            reuseExistingServer: true,
            timeout: 30_000,
            stdout: "pipe",
            stderr: "pipe",
          },
          {
            command: `cd ${rootDir}/apps/web && CRON_SECRET=development ALLOW_TEST_PRIVY_DID_AUTH=true DISABLE_RATE_LIMITING=true bunx next start --hostname ${serverHostname} --port ${serverPort}`,
            url: baseURL,
            reuseExistingServer: true,
            timeout: 120_000,
            stdout: "pipe",
            stderr: "pipe",
          },
        ],
});

/**
 * Playwright configuration for the Playwright Ui Packaged app test lane,
 * including browser projects and app-server wiring.
 */

import { defineConfig, devices } from "@playwright/test";
import { testOutputPath } from "../scripts/lib/test-output.ts";

export default defineConfig({
  outputDir: testOutputPath("app", "ui-packaged"),
  testDir: "./test/ui-smoke",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: ["--allow-file-access-from-files"],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

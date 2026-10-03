/**
 * Playwright configuration for the Playwright Electrobun Packaged app test
 * lane, including browser projects and app-server wiring.
 */
import { defineConfig } from "@playwright/test";
import { testOutputPath } from "../scripts/lib/test-output.ts";
// Build the packaged Electrobun application before running this suite.
// The dev-server UI suite is configured separately in playwright.ui-smoke.config.ts.
export default defineConfig({
  outputDir: testOutputPath("app", "electrobun.packaged"),
  testDir: "./test/electrobun-packaged",
  testMatch: ["**/*.e2e.spec.ts"],
  testIgnore:
    process.platform === "win32"
      ? []
      : ["**/electrobun-windows-startup.e2e.spec.ts"],
  timeout: 600000,
  expect: {
    timeout: 30000,
  },
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});

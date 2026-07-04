/**
 * Playwright configuration for the standalone Feed DAG visualizer.
 *
 * Recording mode redirects traces, screenshots, and videos into the shared
 * evidence directory while normal local runs keep artifacts beside the tool.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const recording = !!process.env.E2E_RECORD;

export default defineConfig({
  testDir: path.resolve(__dirname, "tests"),
  testMatch: "**/*.spec.mjs",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: recording
    ? path.resolve(
        __dirname,
        "../../../../e2e-recordings/feed-dag-visualizer/test-results",
      )
    : path.resolve(__dirname, "test-results"),
  use: {
    trace: recording ? "on" : "on-first-retry",
    screenshot: recording ? "on" : "only-on-failure",
    video: recording ? "on" : "retain-on-failure",
    actionTimeout: 10_000,
    launchOptions: {
      args: ["--disable-dev-shm-usage", "--disable-gpu"],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

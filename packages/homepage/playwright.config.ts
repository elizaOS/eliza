/**
 * Playwright configuration for the homepage route, visual, and recording suites.
 */
import path from "node:path";
import { defineConfig, devices } from "playwright/test";
import { resolveHomepageE2eBaseUrl } from "./scripts/e2e-port.mjs";

const recording = !!process.env.E2E_RECORD;
// Per-runner port: 6-8 self-hosted runners share a host, and a fixed port made
// two concurrent homepage jobs race for it (see scripts/e2e-port.mjs).
const baseURL = resolveHomepageE2eBaseUrl();

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  // The homepage's WebGL scenes contend for one software GPU on hosted CI.
  // Serial CI execution keeps terminal canvas frames reproducible.
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 2 : 1,
  reporter: "list",
  timeout: 60_000,
  expect: {
    timeout: 20000,
  },
  outputDir: recording
    ? path.resolve(
        import.meta.dirname,
        "../../e2e-recordings/homepage/test-results",
      )
    : "./test-results",
  use: {
    baseURL,
    trace: recording ? "on" : "retain-on-failure",
    screenshot: recording ? "on" : "only-on-failure",
    video: recording ? "on" : "retain-on-failure",
  },
  webServer: {
    command: "node scripts/run-playwright-web-server.mjs",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
});

/**
 * Playwright config for the registered-views story harness.
 */
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the registered-views GUI/XR screenshot harness. Boots
 * the ui stories dev server (serves /registered-views.html keyless) and runs the
 * capture spec against it.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /registered-views\.spec\.ts/,
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "/tmp/regviews-shots/test-results",
  use: {
    baseURL: "http://localhost:4321",
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    screenshot: "off",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run stories:dev",
    cwd: resolve(import.meta.dirname, "../.."),
    port: 4321,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

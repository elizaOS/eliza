/**
 * Playwright coverage for the headset WebXR client served through the facewear
 * view-host route.
 */
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const recording = !!process.env.E2E_RECORD;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  outputDir: recording
    ? path.resolve(
        import.meta.dirname,
        "../../../e2e-recordings/app-xr/test-results",
      )
    : "./test-results",
  use: {
    baseURL: process.env.XR_BASE_URL ?? "http://localhost:31337",
    trace: recording ? "on" : "on-first-retry",
    screenshot: recording ? "on" : "only-on-failure",
    video: recording ? "on" : "retain-on-failure",
  },
  webServer: {
    // Serves the REAL view-host route output (no mock markup). Bun runs the .ts route.
    command: "bun e2e/route-server.ts",
    port: 31337,
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

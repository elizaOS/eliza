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
    command: "node e2e/view-server.mjs",
    port: 31337,
    reuseExistingServer: !process.env.CI,
    timeout: 10000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

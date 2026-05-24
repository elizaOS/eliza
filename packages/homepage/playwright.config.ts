import path from "node:path";
import { defineConfig, devices } from "playwright/test";

const recording = !!process.env.E2E_RECORD;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 1,
  reporter: "list",
  expect: {
    timeout: 20000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.05 },
  },
  outputDir: recording
    ? path.resolve(
        import.meta.dirname,
        "../../e2e-recordings/homepage/test-results",
      )
    : "./test-results",
  use: {
    baseURL: "http://127.0.0.1:4444",
    trace: recording ? "on" : "retain-on-failure",
    screenshot: recording ? "on" : "only-on-failure",
    video: recording ? "on" : "retain-on-failure",
  },
  webServer: {
    command:
      "node ../shared/scripts/sync-to-public.mjs ./public && VITE_ELIZACLOUD_API_URL=https://www.elizacloud.ai node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4444",
    url: "http://127.0.0.1:4444",
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

import { defineConfig, devices } from "playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  expect: {
    timeout: 20000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.05 },
  },
  use: {
    baseURL: "http://127.0.0.1:4444",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
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

import { defineConfig, devices } from "@playwright/test";

// When CLOUD_E2E_LIVE_URL is set we are testing the real deployed site, so we
// don't spin up the local Vite dev server at all.
const LIVE_URL = process.env.CLOUD_E2E_LIVE_URL;
const HOST = process.env.PLAYWRIGHT_HOST || "127.0.0.1";
const PORT = process.env.PLAYWRIGHT_PORT || "4173";
const LOCAL_URL = process.env.PLAYWRIGHT_BASE_URL || `http://${HOST}:${PORT}`;
const BASE_URL = LIVE_URL ?? LOCAL_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
    },
  },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: LIVE_URL
    ? undefined
    : {
        command: `env -u FORCE_COLOR VITE_PLAYWRIGHT_TEST_AUTH=true VITE_ELIZA_RENDER_TELEMETRY=false bun --bun vite --host ${HOST} --port ${PORT} --strictPort`,
        url: LOCAL_URL,
        reuseExistingServer:
          process.env.CLOUD_FRONTEND_E2E_SERVER_STARTED === "1" ||
          !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
});

import { defineConfig, devices } from "@playwright/test";

// When CLOUD_E2E_LIVE_URL is set we are testing the real deployed site, so we
// don't spin up the local Vite dev server at all.
const LIVE_URL = process.env.CLOUD_E2E_LIVE_URL;

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
    baseURL: LIVE_URL ?? "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: LIVE_URL
    ? undefined
    : {
        // VITE_ELIZA_RENDER_TELEMETRY is intentionally NOT enabled here — its
        // "committed N profiler updates" console.error noise trips the strict
        // console-error assertions in cloud-routes.spec.ts.
        command:
          "env -u FORCE_COLOR VITE_PLAYWRIGHT_TEST_AUTH=true bun --bun vite --host 127.0.0.1 --port 4173",
        url: "http://127.0.0.1:4173",
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

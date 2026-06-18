import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// When CLOUD_E2E_LIVE_URL is set we are testing the real deployed site, so we
// don't spin up the local Vite dev server at all.
const LIVE_URL = process.env.CLOUD_E2E_LIVE_URL;
const HOST = process.env.PLAYWRIGHT_HOST || "127.0.0.1";
const PORT = process.env.PLAYWRIGHT_PORT || "4173";
const LOCAL_URL = process.env.PLAYWRIGHT_BASE_URL || `http://${HOST}:${PORT}`;
const BASE_URL = LIVE_URL ?? LOCAL_URL;
const recording = !!process.env.E2E_RECORD;

// The behavioral-e2e CI gate (CLOUD_E2E_BEHAVIORAL=1) runs every deterministic
// mock-driven flow spec but excludes specs that cannot serve as a required PR
// gate: pixel-diff visual baselines (darwin-only), palette/a11y/route audits
// that carry pre-existing findings tracked separately, and live-backend specs
// that need a real deployment. Everything else — including any newly added flow
// spec — is gated automatically.
const NON_GATING_SPECS = [
  "**/aesthetic-audit.spec.ts",
  "**/visual.spec.ts",
  "**/blue-banned.spec.ts",
  "**/cross-page-hover-audit.spec.ts",
  "**/focus-rings.spec.ts",
  "**/cloud-routes.spec.ts",
  "**/cloud-routes-live.spec.ts",
  "**/route-coverage.spec.ts",
  "**/live-auth-backend.spec.ts",
  "**/live-auth-dashboard.spec.ts",
  "**/live-steward-wallet-login.spec.ts",
];

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  testIgnore:
    process.env.CLOUD_E2E_BEHAVIORAL === "1" ? NON_GATING_SPECS : undefined,
  // Warm up Vite's dep optimizer before any timed test navigates. See
  // tests/e2e/global-setup.ts for the rationale (fixes #8144).
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  // Absorb the occasional environmental flake (a slow paint under cumulative
  // load) in CI so the required behavioral gate stays deterministic; locally
  // run with zero retries for honest fast feedback.
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
    },
  },
  outputDir: recording
    ? path.resolve(
        import.meta.dirname,
        "../../e2e-recordings/cloud-frontend/test-results",
      )
    : "./test-results",
  use: {
    baseURL: BASE_URL,
    trace: recording ? "on" : "retain-on-failure",
    screenshot: recording ? "on" : "only-on-failure",
    video: recording ? "on" : "retain-on-failure",
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

/**
 * Runs the credentialed Cloud trajectory against the canonical staging Pages
 * branch alias. This configuration starts no local server and retains no browser
 * recording, screenshot, or trace; failed tests may retain only the smoke's
 * closed-schema privacy-safe diagnostic output.
 */
import { defineConfig, devices } from "@playwright/test";
import {
  CLOUD_LIVE_NAVIGATION_TIMEOUT_MS,
  CLOUD_LIVE_TRAJECTORY_TIMEOUT_MS,
} from "./test/cloud-live-trajectory-diagnostic";

const DEPLOYED_RENDERER_ALIAS = "https://develop.eliza-app.pages.dev";

export default defineConfig({
  testDir: "./test/ui-smoke",
  testMatch: "cloud-live.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  preserveOutput: "failures-only",
  timeout: CLOUD_LIVE_TRAJECTORY_TIMEOUT_MS,
  expect: { timeout: 30_000 },
  use: {
    baseURL: DEPLOYED_RENDERER_ALIAS,
    navigationTimeout: CLOUD_LIVE_NAVIGATION_TIMEOUT_MS,
    serviceWorkers: "block",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: DEPLOYED_RENDERER_ALIAS,
        navigationTimeout: CLOUD_LIVE_NAVIGATION_TIMEOUT_MS,
        serviceWorkers: "block",
        trace: "off",
        screenshot: "off",
        video: "off",
      },
    },
  ],
});

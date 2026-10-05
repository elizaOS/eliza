/**
 * Runs the credentialed Cloud trajectory against the canonical deployed app.
 * This configuration starts no local server and retains no browser
 * recording, screenshot, or trace; failed tests may retain only the smoke's
 * closed-schema privacy-safe diagnostic output.
 */

import { defineConfig, devices } from "@playwright/test";
import { testOutputPath } from "../scripts/lib/test-output.ts";
import { cloudLiveDeployedRendererOrigin } from "./test/cloud-live-deployed-target";
import {
  CLOUD_LIVE_NAVIGATION_TIMEOUT_MS,
  CLOUD_LIVE_TRAJECTORY_TIMEOUT_MS,
} from "./test/cloud-live-trajectory-diagnostic";

const DEPLOYED_RENDERER_ALIAS = cloudLiveDeployedRendererOrigin(
  process.env.ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV,
);

export default defineConfig({
  outputDir: testOutputPath("app", "cloud-deployed"),
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

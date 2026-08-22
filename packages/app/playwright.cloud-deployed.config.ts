/**
 * Runs the credentialed Cloud trajectory against the canonical staging Pages
 * branch alias. This configuration starts no local server and retains no browser
 * recording, screenshot, trace, or report artifact.
 */
import { defineConfig, devices } from "@playwright/test";

const DEPLOYED_RENDERER_ALIAS = "https://develop.eliza-app.pages.dev";

export default defineConfig({
  testDir: "./test/ui-smoke",
  testMatch: "cloud-live.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  preserveOutput: "never",
  timeout: 900_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: DEPLOYED_RENDERER_ALIAS,
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
        serviceWorkers: "block",
        trace: "off",
        screenshot: "off",
        video: "off",
      },
    },
  ],
});

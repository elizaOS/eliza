/** Defines app-core playwright behavior for dashboard host and runtime integration. */
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const storybookPort = Number(process.env.ELIZA_UI_STORYBOOK_PORT || "6106");
const recording = !!process.env.E2E_RECORD;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: recording
    ? path.resolve(
        import.meta.dirname,
        "../../e2e-recordings/app-core/test-results",
      )
    : "./test-results",
  use: {
    baseURL: `http://127.0.0.1:${storybookPort}`,
    trace: recording ? "on" : "retain-on-failure",
    screenshot: recording ? "on" : "only-on-failure",
    video: recording ? "on" : "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `bun run storybook -- --ci --host 127.0.0.1 --port ${storybookPort}`,
    cwd: import.meta.dirname,
    port: storybookPort,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});

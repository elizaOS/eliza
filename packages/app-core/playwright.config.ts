import { defineConfig, devices } from "@playwright/test";

const storybookPort = Number(process.env.ELIZA_UI_STORYBOOK_PORT || "6106");

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
  use: {
    baseURL: `http://127.0.0.1:${storybookPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
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

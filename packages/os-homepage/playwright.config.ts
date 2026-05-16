import { defineConfig, devices } from "playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  webServer: {
    command:
      "bun run build && bun --bun vite preview --host 127.0.0.1 --port 4455",
    url: "http://127.0.0.1:4455",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4455",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
});

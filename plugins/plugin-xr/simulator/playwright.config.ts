import { defineConfig, devices } from "@playwright/test";

// Self-contained XR harness e2e: a static test page + the IWER-backed emulator
// (injected by the fixture). No real agent or headset — deterministic, headless,
// byte-stable. E2E_RECORD turns on trace/screenshot/video capture.
const record = process.env.E2E_RECORD === "1";
const port = Number(process.env.XR_HARNESS_PORT ?? 31350);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 720 },
    trace: record ? "on" : "off",
    screenshot: record ? "on" : "off",
    video: record ? "on" : "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/serve.mjs",
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

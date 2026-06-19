import path from "node:path";
import { defineConfig, devices } from "playwright/test";

const recording = !!process.env.E2E_RECORD;

export default defineConfig({
  testDir: "./tests",
  outputDir: recording
    ? path.resolve(
        import.meta.dirname,
        "../../../e2e-recordings/os-usb-installer/test-results",
      )
    : "./test-results",
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  webServer: {
    command:
      "bun run build && bun --bun vite preview --host 127.0.0.1 --port 4456",
    url: "http://127.0.0.1:4456",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4456",
    trace: recording ? "on" : "retain-on-failure",
    screenshot: recording ? "on" : "only-on-failure",
    video: recording ? "on" : "retain-on-failure",
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

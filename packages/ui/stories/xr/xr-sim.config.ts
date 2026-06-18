import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/** Playwright config for the XR simulation harness. Boots the ui stories dev
 *  server (which serves /xr-sim.html) and runs the spec against it. */
export default defineConfig({
  testDir: ".",
  testMatch: /xr-sim\.spec\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "/tmp/xr-shots/test-results",
  use: {
    baseURL: "http://localhost:4321",
    viewport: { width: 1280, height: 820 },
    deviceScaleFactor: 1,
    screenshot: "off",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run stories:dev",
    cwd: resolve(import.meta.dirname, "../.."),
    port: 4321,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

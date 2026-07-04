/**
 * Playwright configuration for the Feed web end-to-end suite. Runs the tests/
 * specs serially (single worker, one retry) under desktop Chromium against a
 * live app. The webServer block boots the keyless localnet harness (anvil +
 * contracts + app via tools/chroma/dev-server.ts) when the target port is free
 * and reuses an already-running server otherwise, gating readiness on
 * /api/health returning 200.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.resolve(__dirname, "tests");

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
const chromaDir = path.resolve(__dirname, "../chroma");
const readyURL = new URL("/api/health", baseURL).toString();

export default defineConfig({
  testDir,
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 45_000,
    navigationTimeout: 60_000,
    launchOptions: {
      args: ["--disable-dev-shm-usage", "--disable-gpu"],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Keyless localnet harness: boots anvil + contracts + the app when nothing
  // is already listening on the target port; reuses an externally started
  // app otherwise. Readiness is the real signal: /api/health returning 200.
  webServer: {
    command: `cd ${chromaDir} && PLAYWRIGHT_BASE_URL=${baseURL} bun run dev-server.ts`,
    url: readyURL,
    reuseExistingServer: true,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

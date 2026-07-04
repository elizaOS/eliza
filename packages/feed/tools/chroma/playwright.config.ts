/**
 * Playwright configuration for Feed's Chroma browser regression lane.
 *
 * It wires the local dev server, serialized Chromium execution, and retained
 * failure artifacts for the tests under `tools/chroma/specs`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const testDir = path.resolve(__dirname, "specs");

dotenv.config({ path: path.resolve(repoRoot, ".env.local") });
dotenv.config({ path: path.resolve(repoRoot, ".env") });

process.env.PLAYWRIGHT_BASE_URL ??= "http://127.0.0.1:3100";

const baseURL = process.env.PLAYWRIGHT_BASE_URL;
const readyURL = new URL("/api/health", baseURL).toString();

export default defineConfig({
  globalSetup: path.resolve(__dirname, "global-setup.ts"),
  testDir,
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 2,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["json", { outputFile: "test-results/chroma-results.json" }]]
    : [["list"], ["json", { outputFile: "test-results/chroma-results.json" }]],
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
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer: process.env.CI
    ? undefined
    : {
        command: `cd ${__dirname} && bun run dev-server.ts`,
        url: readyURL,
        reuseExistingServer: false,
        timeout: 300_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});

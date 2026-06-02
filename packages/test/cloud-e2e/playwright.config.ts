import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The harness seeds users (and encrypts their API keys) directly in the
// Playwright runner process — not in a spawned subprocess — so the env block
// in `src/fixtures/env.ts` does not cover this code path. Pin the test
// defaults here, before cloud-shared crypto is first imported, so KMS resolves
// to the in-memory adapter regardless of the developer's ambient shell.
// Without this, `createKmsClient()` falls through to the `steward` backend and
// `seedTestUser()` throws "ELIZA_KMS_BACKEND=steward requires steward.{...}".
process.env.NODE_ENV ??= "test";
process.env.ELIZA_KMS_BACKEND ??= "memory";

const frontendUrl = process.env.E2E_FRONTEND_URL ?? "http://127.0.0.1:0";
const recording = !!process.env.E2E_RECORD;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: frontendUrl,
    trace: recording ? "on" : "retain-on-failure",
    screenshot: recording ? "on" : "only-on-failure",
    video: recording ? "on" : "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  outputDir: recording
    ? path.resolve(
        import.meta.dirname,
        "../../../e2e-recordings/cloud-e2e/test-results",
      )
    : "./test-results",
});

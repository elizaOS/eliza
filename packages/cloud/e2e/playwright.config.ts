/** Configures the cloud E2E Playwright project to boot a serial mock-backed local cloud stack. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Load cloud/shared/.env into process.env (without overriding an explicit shell
// value) so provider keys placed there — e.g. CEREBRAS_API_KEY for the real-LLM
// marquee lane — are visible to BOTH this runner's test gates and the booted
// worker (the cloud-api dev wrapper already syncs the same file into .dev.vars).
// Mirrors how sync-api-dev-vars sources keys, so "put it in .env and go" works.
const configDir = path.dirname(fileURLToPath(import.meta.url));
for (const envFile of [
  path.resolve(configDir, "../../cloud/shared/.env"),
  path.resolve(configDir, "../../cloud/shared/.env.local"),
]) {
  if (!fs.existsSync(envFile)) continue;
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (value) process.env[key] = value;
  }
}

// The harness seeds users (and encrypts their API keys) directly in the
// Playwright runner process — not in a spawned subprocess — so the env block
// in `src/fixtures/env.ts` does not cover this code path. Pin the test
// defaults here, before cloud-shared crypto is first imported, so KMS resolves
// to a deterministic local adapter regardless of the developer's ambient shell.
// The e2e stack spans multiple processes (runner, Worker, control plane), so an
// in-memory adapter cannot decrypt rows written by a sibling process.
// Without this, `createKmsClient()` falls through to the `steward` backend and
// `seedTestUser()` throws "ELIZA_KMS_BACKEND=steward requires steward.{...}".
process.env.NODE_ENV ??= "test";
process.env.ELIZA_KMS_BACKEND ??= "local";
process.env.ELIZA_LOCAL_ROOT_KEY ??=
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const bunSourceCondition = "--conditions=eliza-source";
if (!process.env.BUN_OPTIONS?.includes(bunSourceCondition)) {
  process.env.BUN_OPTIONS = process.env.BUN_OPTIONS?.trim()
    ? `${process.env.BUN_OPTIONS} ${bunSourceCondition}`
    : bunSourceCondition;
}

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

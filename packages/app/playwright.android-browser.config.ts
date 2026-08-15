/**
 * Playwright configuration for the Playwright Android Browser app test lane,
 * including browser projects and app-server wiring.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { KNOWN_PHRASE_WAV_DATA_URL } from "../ui/src/voice/voice-selftest/fixtures/known-phrase";
import { resolvePlaywrightNodeRuntime } from "./scripts/lib/playwright-node-runtime.mjs";
import { resolvePlaywrightPortEnv } from "./scripts/lib/playwright-port.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");
const uiSmokeLiveStack = path.join(
  repoRoot,
  "packages",
  "app-core",
  "scripts",
  "playwright-ui-live-stack.ts",
);
// Fail closed on explicit port typos before baseURL/webServer wiring.
const uiSmokeApiPort = resolvePlaywrightPortEnv(
  process.env,
  "ELIZA_UI_SMOKE_API_PORT",
  31337,
);
const uiSmokePort = resolvePlaywrightPortEnv(
  process.env,
  "ELIZA_UI_SMOKE_PORT",
  2138,
);
// Fail-fast Node runtime resolution: the shared app-core validator throws at
// config load — before the webServer command spawns — when ELIZA_NODE_PATH is
// invalid or no real Node.js 24+ executable can be found.
const nodeExecutable = resolvePlaywrightNodeRuntime();

const fakeAudioWav = path.join(
  appDir,
  "test-results",
  ".voice",
  "known-phrase.wav",
);
mkdirSync(path.dirname(fakeAudioWav), { recursive: true });
writeFileSync(
  fakeAudioWav,
  Buffer.from(KNOWN_PHRASE_WAV_DATA_URL.split(",")[1] ?? "", "base64"),
);

if (!process.env.ELIZA_API_PORT) {
  process.env.ELIZA_API_PORT = String(uiSmokeApiPort);
}

export default defineConfig({
  testDir: "./test/android-browser",
  testMatch: /.*\.android-browser\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  outputDir: "./test-results/android-browser",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `${JSON.stringify(nodeExecutable)} ${JSON.stringify(path.join(repoRoot, "packages", "app-core", "scripts", "run-node-tsx.mjs"))} ${JSON.stringify(uiSmokeLiveStack)}`,
    cwd: repoRoot,
    url: `http://127.0.0.1:${uiSmokePort}`,
    reuseExistingServer: process.env.ELIZA_UI_SMOKE_REUSE_SERVER === "1",
    timeout: 1_200_000,
  },
});

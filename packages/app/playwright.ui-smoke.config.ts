import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");
const uiSmokeLiveStack = path.join(
  repoRoot,
  "packages",
  "app-core",
  "scripts",
  "playwright-ui-live-stack.ts",
);
const uiSmokeApiPort = Number(process.env.ELIZA_UI_SMOKE_API_PORT || "31337");
const uiSmokePort = Number(process.env.ELIZA_UI_SMOKE_PORT || "2138");
const reuseExistingServer = process.env.ELIZA_UI_SMOKE_REUSE_SERVER === "1";

// Keep the app's API port env aligned with the live stack when the suite runs
// on non-default ports.
if (!process.env.ELIZA_API_PORT) {
  process.env.ELIZA_API_PORT = String(uiSmokeApiPort);
}

export default defineConfig({
  testDir: "./test/ui-smoke",
  timeout: 180_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${uiSmokePort}`,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      testMatch: /backgrounds\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: `node ${JSON.stringify(path.join(repoRoot, "packages", "app-core", "scripts", "run-node-tsx.mjs"))} ${JSON.stringify(uiSmokeLiveStack)}`,
    cwd: repoRoot,
    port: uiSmokePort,
    reuseExistingServer,
    timeout: 240_000,
  },
});

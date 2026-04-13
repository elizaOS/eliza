import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");
const uiSmokeApiStub = path.join(
  repoRoot,
  "eliza",
  "packages",
  "app-core",
  "scripts",
  "playwright-ui-smoke-api-stub.mjs",
);
const uiSmokeApiPort = Number(process.env.ELIZA_UI_SMOKE_API_PORT || "31337");
const uiSmokePort = Number(process.env.ELIZA_UI_SMOKE_PORT || "2138");

// Keep the Vite preview proxy aligned with the smoke API stub when the suite
// runs on non-default ports. The app's Vite config reads ELIZA_API_PORT.
if (!process.env.ELIZA_API_PORT) {
  process.env.ELIZA_API_PORT = String(uiSmokeApiPort);
}

export default defineConfig({
  testDir: "./test/ui-smoke",
  timeout: 120_000,
  expect: {
    timeout: 10_000,
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
  ],
  webServer: [
    {
      command: `node ${JSON.stringify(uiSmokeApiStub)}`,
      cwd: repoRoot,
      port: uiSmokeApiPort,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `bun run build:web && bun run preview -- --host 127.0.0.1 --port ${uiSmokePort}`,
      cwd: appDir,
      port: uiSmokePort,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});

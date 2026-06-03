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
const chromiumExecutablePath =
  process.env.ELIZA_UI_SMOKE_CHROMIUM_EXECUTABLE?.trim();
const recording = !!process.env.E2E_RECORD;
const videoMode =
  process.env.ELIZA_UI_SMOKE_DISABLE_VIDEO === "1"
    ? "off"
    : recording
      ? "on"
      : "retain-on-failure";

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
  outputDir: recording
    ? path.resolve(appDir, "../../e2e-recordings/app/test-results")
    : "./test-results",
  use: {
    baseURL: `http://127.0.0.1:${uiSmokePort}`,
    trace: recording ? "on" : "retain-on-failure",
    video: videoMode,
    screenshot: recording ? "on" : "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(chromiumExecutablePath
          ? { launchOptions: { executablePath: chromiumExecutablePath } }
          : {}),
      },
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
    // A cold renderer build transforms ~3000 modules (~12 min) before the smoke
    // harness can bind the port; the live stack caps the build at 18 min, so the
    // outer wait must exceed that (was 7 min, which killed every cold build).
    timeout: 1_200_000,
  },
});

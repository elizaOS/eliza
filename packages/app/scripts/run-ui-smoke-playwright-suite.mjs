/**
 * Launches the app package's UI-smoke Playwright runner
 * (scripts/run-ui-playwright.mjs), resolving the app dir from this script
 * and reserving free localhost ports for the stub API and UI before spawning.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort } from "../test/utils/get-free-port.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const uiPlaywrightRunner = path.join(
  appDir,
  "scripts",
  "run-ui-playwright.mjs",
);
const nodeCmd =
  typeof process.execPath === "string" && process.execPath.length > 0
    ? process.execPath
    : process.platform === "win32"
      ? "node.exe"
      : "node";

const specFiles = [
  "test/ui-smoke/apps-session.spec.ts",
  "test/ui-smoke/apps-session-direct-a.spec.ts",
  "test/ui-smoke/apps-session-direct-b.spec.ts",
  "test/ui-smoke/browser-workspace.spec.ts",
  "test/ui-smoke/cloud-wallet-import.spec.ts",
  "test/ui-smoke/connectors.spec.ts",
];

const env = { ...process.env };
delete env.CI;
env.ELIZA_UI_SMOKE_FORCE_STUB = env.ELIZA_UI_SMOKE_FORCE_STUB || "1";

if (!env.ELIZA_UI_SMOKE_API_PORT) {
  const apiPort = await getFreePort();
  env.ELIZA_UI_SMOKE_API_PORT = String(apiPort);
}
env.ELIZA_API_PORT = env.ELIZA_API_PORT || env.ELIZA_UI_SMOKE_API_PORT;

if (!env.ELIZA_UI_SMOKE_PORT) {
  const uiPort = await getFreePort();
  env.ELIZA_UI_SMOKE_PORT = String(uiPort);
}
env.ELIZA_PORT = env.ELIZA_PORT || env.ELIZA_UI_SMOKE_PORT;

for (const spec of specFiles) {
  const result = spawnSync(
    nodeCmd,
    [uiPlaywrightRunner, "--config", "playwright.ui-smoke.config.ts", spec],
    {
      cwd: appDir,
      env,
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMainAppDir } from "./lib/app-dir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidateRoots = [
  path.resolve(here, ".."),
  path.resolve(here, "..", "..", "..", ".."),
];
const repoRoot =
  candidateRoots.find((candidate) =>
    fs.existsSync(
      path.join(resolveMainAppDir(candidate, "app"), "package.json"),
    ),
  ) ?? path.resolve(here, "..");
const appDir = resolveMainAppDir(repoRoot, "app");
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
  "test/ui-smoke/ui-smoke.spec.ts",
];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free port."));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

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
      cwd: repoRoot,
      env,
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

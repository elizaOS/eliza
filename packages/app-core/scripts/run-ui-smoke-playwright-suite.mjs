import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const nodeCmd =
  typeof process.execPath === "string" && process.execPath.length > 0
    ? process.execPath
    : process.platform === "win32"
      ? "node.exe"
      : "node";

const specGroups = [
  [
    "test/ui-smoke/apps-session.spec.ts",
    "test/ui-smoke/browser-workspace.spec.ts",
  ],
  ["test/ui-smoke/ui-smoke.spec.ts"],
];

for (const specs of specGroups) {
  const result = spawnSync(
    nodeCmd,
    [
      "apps/app/scripts/run-ui-playwright.mjs",
      "--config",
      "playwright.ui-smoke.config.ts",
      ...specs,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APP_CORE_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(APP_CORE_ROOT, "..", "..", "..");

const releaseContractTests = [
  "eliza/packages/app-core/scripts/asset-cdn.test.ts",
  "eliza/packages/app-core/scripts/docker-contract.test.ts",
  "eliza/packages/app-core/scripts/chrome-extension-release-surface.test.ts",
  "eliza/packages/app-core/scripts/electrobun-release-workflow-drift.test.ts",
  "eliza/packages/app-core/scripts/electrobun-test-workflow-drift.test.ts",
  "eliza/packages/app-core/scripts/whisper-build-script-drift.test.ts",
  "eliza/packages/app-core/scripts/release-check.test.ts",
  "eliza/packages/app-core/scripts/static-asset-manifest.test.ts",
];

function run(command, args, cwd = APP_CORE_ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS ?? "1",
    },
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("bunx", ["vitest", "run", ...releaseContractTests], REPO_ROOT);
run(
  "bunx",
  [
    "vitest",
    "run",
    "eliza/packages/app-core/scripts/startup-integration-script-drift.test.ts",
  ],
  REPO_ROOT,
);

// tsdown and the release check both resolve repo-root-relative entries/config.
run("bunx", ["tsdown", "--fail-on-warn", "false"], REPO_ROOT);
fs.mkdirSync(path.join(REPO_ROOT, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(REPO_ROOT, "dist", "package.json"),
  '{"type":"module"}\n',
);
run("node", ["--import", "tsx", "scripts/write-build-info.ts"], REPO_ROOT);
// Regenerate static asset manifest from the CI build output so hashes
// match what release:check will validate.
run("node", ["scripts/generate-static-asset-manifest.mjs"]);
run("bun", ["run", "release:check"], REPO_ROOT);

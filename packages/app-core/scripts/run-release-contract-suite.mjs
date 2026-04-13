import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
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

run("bunx", [
  "vitest",
  "run",
  "scripts/asset-cdn.test.ts",
  "scripts/docker-contract.test.ts",
  "scripts/chrome-extension-release-surface.test.ts",
  "scripts/electrobun-release-workflow-drift.test.ts",
  "scripts/electrobun-test-workflow-drift.test.ts",
  "scripts/whisper-build-script-drift.test.ts",
  "scripts/release-check.test.ts",
  "scripts/static-asset-manifest.test.ts",
]);
run("bun", ["run", "test:startup:contract"]);

run("bunx", ["tsdown"]);
fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "dist", "package.json"),
  '{"type":"module"}\n',
);
run("node", ["--import", "tsx", "scripts/write-build-info.ts"]);
// Regenerate static asset manifest from the CI build output so hashes
// match what release:check will validate.
run("node", ["scripts/generate-static-asset-manifest.mjs"]);
run("bun", ["run", "release:check"]);

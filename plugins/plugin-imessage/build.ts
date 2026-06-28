import { execSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = join(import.meta.dirname, "dist");
const RM_RECURSIVE_SCRIPT = fileURLToPath(
  new URL("../../packages/scripts/rm-path-recursive.mjs", import.meta.url)
);

function rmRecursive(target: string) {
  const result = spawnSync(process.execPath, [RM_RECURSIVE_SCRIPT, target], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`rm-path-recursive failed for ${target} with status ${result.status}`);
  }
}

// Clean
rmRecursive(distDir);

// Build with Bun's bundled TypeScript runner so Windows CI does not fall back
// to the unrelated `tsc` npm package via `npx`.
execSync("bun x tsc -p tsconfig.json --noCheck", {
  cwd: import.meta.dirname,
  stdio: "inherit",
});

console.log("Build complete: plugin-imessage");

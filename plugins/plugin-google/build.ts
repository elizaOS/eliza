import { execSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const rmRecursiveScript = join(
  import.meta.dirname,
  "..",
  "..",
  "packages",
  "scripts",
  "rm-path-recursive.mjs"
);

function rmRecursive(targetPath: string) {
  const result = spawnSync(process.execPath, [rmRecursiveScript, targetPath], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`failed to remove generated Google plugin build output ${targetPath}`);
  }
}

console.log("Building Google plugin (TypeScript)...");
rmRecursive("dist");
execSync("bunx tsc -p tsconfig.json --noCheck", { stdio: "inherit" });
console.log("Build complete.");

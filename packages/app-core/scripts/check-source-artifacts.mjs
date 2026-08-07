/**
 * Rejects compiler declaration debris in app-core source trees while allowing
 * the two ambient declaration inputs that are intentionally maintained by hand.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(fileURLToPath(import.meta.url), "../..");
const repoRoot = path.resolve(packageDir, "../..");
const allowed = new Set([
  "packages/app-core/vite-env.d.ts",
  "packages/app-core/platforms/electrobun/src/types/web-speech.d.ts",
]);
const files = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "packages/app-core",
  ],
  { cwd: repoRoot, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);
const unexpected = files.filter(
  (file) =>
    (file.endsWith(".d.ts") || file.endsWith(".d.ts.map")) &&
    !allowed.has(file),
);

if (unexpected.length > 0) {
  throw new Error(
    `Generated declaration artifacts found outside dist:\n${unexpected.join("\n")}`,
  );
}

console.log(
  `[source-artifacts] OK: ${allowed.size} intentional ambient declarations; no compiler debris`,
);

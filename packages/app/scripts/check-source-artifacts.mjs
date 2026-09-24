/**
 * Rejects compiler declaration debris in app source trees while allowing
 * the host and renderer declaration inputs that are intentionally maintained by hand.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(fileURLToPath(import.meta.url), "../..");
const repoRoot = path.resolve(packageDir, "../..");
const allowed = new Set([
  "packages/app/vite-env.d.ts",
  "packages/app/platforms/electrobun/src/types/web-speech.d.ts",
  "packages/app/src/env-prefix.d.ts",
  "packages/app/src/types/app-plugin-module-exports.d.ts",
  "packages/app/src/types/app-plugin-modules.d.ts",
  "packages/app/src/types/side-effect-app-modules.d.ts",
  "packages/app/src/types/typecheck-package-shims.d.ts",
  "packages/app/test/utils/get-free-port.d.ts",
]);
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "packages/app"],
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

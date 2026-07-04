/**
 * Release helper that stamps publishConfig.access="public" onto public @elizaos packages.
 *
 * Scoped packages default to restricted access, which fails on the free @elizaos
 * npm organization during `lerna publish from-package`. Lerna publishes through
 * libnpmpublish and honors each package's publishConfig.access rather than the
 * npmrc access key, so this script sets the per-package field and leaves private
 * packages untouched.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const files = execSync("git ls-files '*package.json'")
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean);

let changed = 0;
for (const file of files) {
  if (file.includes("/node_modules/")) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  if (!pkg.name || !pkg.name.startsWith("@elizaos/") || pkg.private) continue;
  if (pkg.publishConfig?.access === "public") continue;
  pkg.publishConfig = { ...(pkg.publishConfig ?? {}), access: "public" };
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  changed += 1;
}
console.log(
  `[release] set publishConfig.access=public on ${changed} package(s)`,
);

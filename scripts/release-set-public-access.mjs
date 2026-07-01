// Stamp publishConfig.access="public" onto every public @elizaos/* package
// before `lerna publish from-package`. New scoped packages default to
// "restricted" access, which fails with `E402 You must sign up for private
// packages` on the free @elizaos org and aborts the whole release mid-stream.
// lerna publishes via libnpmpublish and honours each package's
// publishConfig.access (NOT the npmrc `access` key), so it must be set
// per-package. Private packages are skipped by lerna entirely and left alone.

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

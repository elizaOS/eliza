#!/usr/bin/env node
// Collapse the over-eager rewrites in package.json dependencies:
//   "@elizaos/shared/<subpath>": "workspace:*"  ->  "@elizaos/shared": "workspace:*"
// And the same for "@elizaos/scenario-runner/schema" -> "@elizaos/scenario-runner".
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

const SKIP = new Set([
  "node_modules",
  ".git",
  ".claude",
  "dist",
  "build",
  "eliza",
  "worktrees",
]);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith("dist-") || e.name.startsWith("build-")) continue;
      yield* walk(p);
    } else if (e.isFile() && e.name === "package.json") {
      yield p;
    }
  }
}

let count = 0;
for (const pkgPath of walk(ROOT)) {
  let txt;
  try {
    txt = readFileSync(pkgPath, "utf8");
  } catch {
    continue;
  }
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    continue;
  }

  let changed = false;
  for (const block of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps = json[block];
    if (!deps) continue;
    const rewrites = [];
    for (const [name, ver] of Object.entries(deps)) {
      // Match "@elizaos/shared/<anything>" or "@elizaos/scenario-runner/<anything>"
      const m = name.match(/^(@elizaos\/(shared|scenario-runner))\/[^\s]+$/);
      if (m) rewrites.push([name, m[1], ver]);
    }
    for (const [oldName, newName, ver] of rewrites) {
      delete deps[oldName];
      // dedupe: don't clobber an existing entry with weaker constraint
      if (!deps[newName]) deps[newName] = ver;
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(pkgPath, JSON.stringify(json, null, 2) + "\n");
    count++;
    console.log("fixed", path.relative(ROOT, pkgPath));
  }
}
console.log(`done: ${count} package.json files`);

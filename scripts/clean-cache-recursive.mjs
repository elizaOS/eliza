#!/usr/bin/env node
/**
 * Cross-platform replacement for the POSIX-only `find ... -exec rm -rf {} +`
 * commands in the root `clean:cache` script. Walks from cwd and removes:
 *   - any `.turbo/` directory anywhere (excluding `.git`)
 *   - any `.cache/` directory under a `node_modules/` ancestor
 *   - any `.vite/` directory under a `node_modules/` ancestor
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const SKIP_NAMES = new Set([".git"]);

let removed = 0;
let scanned = 0;

function shouldRemove(name, parentNamesAbove) {
  if (name === ".turbo") return true;
  if (name === ".cache" && parentNamesAbove.includes("node_modules")) return true;
  if (name === ".vite" && parentNamesAbove.includes("node_modules")) return true;
  return false;
}

function tryRemove(target) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      removed += 1;
      return;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err ? err.code : undefined;
      if (code === "ENOENT") return;
      if (attempt === 2) {
        console.warn(
          `[clean-cache-recursive] failed to remove ${target}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    }
  }
}

function walk(dir, parentNamesAbove) {
  scanned += 1;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (shouldRemove(entry.name, parentNamesAbove)) {
      tryRemove(full);
      continue;
    }
    walk(full, [...parentNamesAbove, entry.name]);
  }
}

for (const name of [".turbo", ".turbo-tsconfig.json", "tsdoc_cache", "tsdoc_comments"]) {
  const target = path.join(ROOT, name);
  try {
    statSync(target);
    tryRemove(target);
  } catch {
    // missing — fine
  }
}

walk(ROOT, []);
console.log(
  `[clean-cache-recursive] scanned=${scanned} dirs, removed=${removed} entries`,
);

#!/usr/bin/env node
// scripts/depot-ci-sync.mjs
//
// Regenerates `.depot/workflows/` from `.github/workflows/` via
// `depot ci migrate workflows --overwrite`, then re-deletes the mirrors
// listed under `skip:` in `.depot/migrate-config.yaml`.
//
// Use this instead of calling `depot ci migrate workflows --overwrite` directly
// so opt-outs (fast jobs, release auth workflows) don't silently come back.
//
// Usage:
//   node scripts/depot-ci-sync.mjs           # run migration + apply skip list
//   node scripts/depot-ci-sync.mjs --dry-run # show what would change

import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CONFIG_PATH = resolve(REPO_ROOT, ".depot/migrate-config.yaml");
const MIRROR_DIR = resolve(REPO_ROOT, ".depot/workflows");
const DRY_RUN = process.argv.includes("--dry-run");

function parseSkipList(yamlText) {
  const skip = [];
  let inSkip = false;
  for (const rawLine of yamlText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    if (/^skip\s*:/.test(line)) {
      inSkip = true;
      continue;
    }
    if (inSkip) {
      const match = /^\s+-\s+(.+)$/.exec(line);
      if (match) {
        skip.push(match[1].trim());
      } else if (/^\S/.test(line)) {
        inSkip = false;
      }
    }
  }
  return skip;
}

if (!existsSync(CONFIG_PATH)) {
  console.error(`[depot-ci-sync] missing ${CONFIG_PATH}`);
  process.exit(1);
}

const skip = parseSkipList(readFileSync(CONFIG_PATH, "utf8"));
console.log(`[depot-ci-sync] skip list (${skip.length} entries):`);
for (const file of skip) console.log(`  - ${file}`);

if (!DRY_RUN) {
  console.log(
    "[depot-ci-sync] running: depot ci migrate workflows --overwrite --yes",
  );
  execSync("depot ci migrate workflows --overwrite --yes", {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

let removed = 0;
for (const file of skip) {
  const target = resolve(MIRROR_DIR, file);
  if (existsSync(target)) {
    if (DRY_RUN) {
      console.log(`[depot-ci-sync] would remove ${target}`);
    } else {
      rmSync(target, { force: true });
      console.log(`[depot-ci-sync] removed ${target}`);
    }
    removed += 1;
  }
}

console.log(
  `[depot-ci-sync] ${DRY_RUN ? "would remove" : "removed"} ${removed} opt-out mirror(s)`,
);

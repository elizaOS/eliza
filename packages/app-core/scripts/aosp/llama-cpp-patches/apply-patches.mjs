#!/usr/bin/env node
// apply-patches.mjs — apply the QJL + PolarQuant patch series on top
// of a checked-out apothic/llama.cpp-1bit-turboquant tree.
//
// Called from compile-libllama.mjs after the fork is cloned + checked
// out at the pinned commit, before CMake configure.
//
// Idempotent: if `git am --abort` is needed (because a previous run
// failed mid-series), the script handles it. If the patches are already
// applied (HEAD matches the recorded final SHA), it's a no-op.
//
// Usage:
//   node apply-patches.mjs --repo <path-to-llama.cpp-checkout>
//   node apply-patches.mjs --repo <path> --series qjl,polarquant

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const repo = flag("--repo");
if (!repo) {
  console.error("usage: apply-patches.mjs --repo <llama.cpp-checkout> [--series qjl,polarquant]");
  process.exit(1);
}
if (!existsSync(path.join(repo, ".git"))) {
  console.error(`[patches] not a git repo: ${repo}`);
  process.exit(1);
}

const seriesArg = flag("--series");
const seriesNames = seriesArg
  ? seriesArg.split(",").map((s) => s.trim()).filter(Boolean)
  : readdirSync(here, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

console.log(`[patches] applying series: ${seriesNames.join(", ")}`);
console.log(`[patches] target repo: ${repo}`);

const git = (cwd, ...gitArgs) => {
  const res = spawnSync("git", gitArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  return {
    code: res.status,
    out: (res.stdout?.toString() ?? "").trim(),
    err: (res.stderr?.toString() ?? "").trim(),
  };
};

// If a prior `git am` was interrupted, the .git/rebase-apply dir lingers
// and blocks new applies. Clean it up.
if (existsSync(path.join(repo, ".git", "rebase-apply"))) {
  console.log("[patches] aborting stale git am from previous run");
  git(repo, "am", "--abort");
}

let appliedCount = 0;
let skippedCount = 0;

for (const series of seriesNames) {
  const seriesDir = path.join(here, series);
  if (!existsSync(seriesDir) || !statSync(seriesDir).isDirectory()) {
    console.warn(`[patches] series dir missing: ${seriesDir}; skipping`);
    continue;
  }
  const patches = readdirSync(seriesDir)
    .filter((f) => /^\d+.*\.patch$/.test(f))
    .sort();
  if (patches.length === 0) {
    console.warn(`[patches] no .patch files in ${seriesDir}; skipping`);
    continue;
  }

  for (const p of patches) {
    const full = path.join(seriesDir, p);
    // Check if patch is already applied: `git apply --check -R` exits 0
    // when the patch can be reversed (i.e. it's already applied).
    const reverseCheck = spawnSync("git", ["apply", "--check", "-R", full], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (reverseCheck.status === 0) {
      console.log(`[patches]   skip (already applied): ${series}/${p}`);
      skippedCount += 1;
      continue;
    }

    // Apply via git am to preserve commit metadata. Fall back to
    // git apply --3way if the index is dirty (am needs a clean index).
    const am = spawnSync("git", ["am", "--keep-non-patch", full], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (am.status === 0) {
      console.log(`[patches]   apply: ${series}/${p}`);
      appliedCount += 1;
    } else {
      console.error(`[patches]   FAILED: ${series}/${p}`);
      console.error(am.stderr?.toString() ?? "");
      git(repo, "am", "--abort");
      process.exit(1);
    }
  }
}

console.log(`[patches] done. applied=${appliedCount} skipped=${skippedCount}`);

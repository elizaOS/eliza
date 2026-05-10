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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Read the first ~64 KB of a patch file as utf8 — enough to see the
// `Subject:` line. Patches can be hundreds of KB once they include the
// vendored kernel sources, so we cap the read.
function readPatchFile(p) {
  const buf = readFileSync(p);
  return buf.subarray(0, Math.min(buf.length, 64 * 1024)).toString("utf8");
}

// Pull the `Subject:` line out of a `git format-patch`-style header.
// Multi-line subjects are joined; the leading `[PATCH n/N]` prefix is
// stripped so the subject matches what `git log --format=%s` emits.
function extractSubject(text) {
  const m = /^Subject:\s*(.+(?:\n[ \t]+.+)*)/m.exec(text);
  if (!m) return null;
  const joined = m[1].replace(/\n[ \t]+/g, " ").trim();
  return joined.replace(/^\[PATCH[^\]]*\]\s*/i, "").trim();
}

// Escape a string for `git log --grep=<pattern>` when used with
// --fixed-strings. We pass it through directly; --fixed-strings makes
// regex metacharacters literal, so the only thing to guard against is
// embedded newlines (subjects are joined to one line in extractSubject).
function escapeGrep(s) {
  return s;
}

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

// Quick gate: when the target repo already contains the upstream
// markers for a series (e.g. v0.4.0-milady has QJL baked in via a merge
// commit, so subject-grep won't match the original patch subjects),
// skip the entire series rather than trying to apply patches that
// would conflict with the already-present source.
const SERIES_BAKED_IN_MARKERS = {
  qjl: {
    file: "ggml/include/ggml.h",
    needle: "GGML_TYPE_QJL1_256",
  },
};

function seriesAlreadyBakedIn(seriesName) {
  const marker = SERIES_BAKED_IN_MARKERS[seriesName];
  if (!marker) return false;
  const filePath = path.join(repo, marker.file);
  if (!existsSync(filePath)) return false;
  try {
    const text = readFileSync(filePath, "utf8");
    return text.includes(marker.needle);
  } catch {
    return false;
  }
}

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
  if (seriesAlreadyBakedIn(series)) {
    const marker = SERIES_BAKED_IN_MARKERS[series];
    console.log(
      `[patches] series '${series}' already in source (${marker.file} contains ${marker.needle}); skipping`,
    );
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
    // Idempotency: skip patches whose commit subject is already in the git
    // log on top of the base. We can't use `git apply --check -R` alone
    // because earlier patches in a series may be modified by later ones,
    // making a stand-alone reverse-apply false-negative even when the patch
    // is in the tree (e.g. qjl/0002 introduces a file that qjl/0004 then
    // edits — reverse-applying 0002 against the post-0004 tree fails
    // because the file no longer matches the patch's pre-image).
    //
    // Strategy: parse the `Subject:` line out of the patch file and grep
    // `git log --grep=` for an exact subject match in the current branch's
    // history. Falls back to the reverse-apply check for patches without a
    // recognisable subject header.
    const patchText = readPatchFile(full);
    const subject = extractSubject(patchText);
    if (subject) {
      const found = spawnSync(
        "git",
        ["log", "--all", `--grep=${escapeGrep(subject)}`, "--fixed-strings", "--format=%H"],
        { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (found.status === 0 && (found.stdout?.toString().trim() ?? "") !== "") {
        console.log(`[patches]   skip (already in git log): ${series}/${p}`);
        skippedCount += 1;
        continue;
      }
    } else {
      const reverseCheck = spawnSync("git", ["apply", "--check", "-R", full], {
        cwd: repo,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (reverseCheck.status === 0) {
        console.log(`[patches]   skip (reverse-apply ok): ${series}/${p}`);
        skippedCount += 1;
        continue;
      }
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

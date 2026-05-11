#!/usr/bin/env node
/**
 * Ensure the in-repo llama.cpp fork submodule (packages/inference/llama.cpp,
 * elizaOS/llama.cpp @ v1.0.0-eliza) is checked out.
 *
 * `build-llama-cpp-dflash.mjs` and `aosp/compile-libllama.mjs` default to
 * building from this submodule; both fall back to a standalone clone when it is
 * absent, so this step is a convenience, not a hard requirement. Idempotent and
 * best-effort: a clean exit even when the submodule can't be fetched (offline,
 * no `.gitmodules` entry yet on an older checkout, etc.) — the build script's
 * own fallback covers that case.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const submoduleRel = join("packages", "inference", "llama.cpp");
const submoduleAbs = join(repoRoot, submoduleRel);
const gitmodules = join(repoRoot, ".gitmodules");

// Already checked out? (a `.git` entry — file for a submodule — plus the
// top-level CMakeLists.txt the build scripts probe for.)
if (
  existsSync(join(submoduleAbs, ".git")) &&
  existsSync(join(submoduleAbs, "CMakeLists.txt"))
) {
  process.exit(0);
}

// No `.gitmodules` entry for it yet (older checkout / before this submodule
// landed) → nothing to do.
if (!existsSync(gitmodules)) {
  process.exit(0);
}
const gm = spawnSync("git", ["config", "-f", gitmodules, "--get-regexp", "path"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (gm.status !== 0 || !gm.stdout.includes(submoduleRel)) {
  process.exit(0);
}

const res = spawnSync(
  "git",
  ["submodule", "update", "--init", "--recursive", submoduleRel],
  { cwd: repoRoot, stdio: "inherit" },
);
if (res.status !== 0) {
  console.warn(
    `[ensure-llama-cpp-submodule] warning: \`git submodule update --init ` +
      `--recursive ${submoduleRel}\` failed (offline?). The llama.cpp build ` +
      `scripts will fall back to a standalone clone under ` +
      `~/.cache/eliza-dflash/milady-llama-cpp.`,
  );
}
process.exit(0);

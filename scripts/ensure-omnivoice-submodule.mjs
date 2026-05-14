#!/usr/bin/env node
/**
 * Ensure the in-repo omnivoice.cpp submodule is checked out.
 *
 * Path: plugins/plugin-local-inference/native/omnivoice.cpp
 * Remote: https://github.com/elizaOS/omnivoice.cpp.git
 *
 * build-omnivoice.mjs probes for CMakeLists.txt in this submodule. The fused
 * libelizainference build also grafts sources from this tree at fuse time
 * (see packages/app-core/scripts/omnivoice-fuse/). If this submodule is
 * absent, every voice-engine build path is broken.
 *
 * Behavior:
 *   - Submodule already initialized + CMakeLists present → exit 0.
 *   - Submodule entry missing from .gitmodules → exit 0 (older checkouts
 *     pre-omnivoice gitlink should not be forced to update).
 *   - `git submodule update --init --recursive` fails → exit 1 with a
 *     clear, actionable error message. Silent install over a broken
 *     voice engine is worse than failing loudly.
 *   - ELIZA_SKIP_OMNIVOICE_SUBMODULE=1 → exit 0 with a single-line warning.
 *     Explicit escape hatch for CI / offline dev that doesn't need to
 *     compile voice. Must be opted in; never the default.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const submoduleRel = join(
  "plugins",
  "plugin-local-inference",
  "native",
  "omnivoice.cpp",
);
const submoduleAbs = join(repoRoot, submoduleRel);
const gitmodules = join(repoRoot, ".gitmodules");
const LOG_PREFIX = "[ensure-omnivoice-submodule]";

if (
  existsSync(join(submoduleAbs, ".git")) &&
  existsSync(join(submoduleAbs, "CMakeLists.txt"))
) {
  process.exit(0);
}

if (!existsSync(gitmodules)) {
  // Older checkouts predating the omnivoice gitlink. Not an error here —
  // the voice build path simply isn't available in those checkouts.
  process.exit(0);
}

const gm = spawnSync(
  "git",
  ["config", "-f", gitmodules, "--get-regexp", "path"],
  { cwd: repoRoot, encoding: "utf8" },
);
if (gm.status !== 0 || !gm.stdout.includes(submoduleRel)) {
  process.exit(0);
}

if (process.env.ELIZA_SKIP_OMNIVOICE_SUBMODULE === "1") {
  console.warn(
    `${LOG_PREFIX} ELIZA_SKIP_OMNIVOICE_SUBMODULE=1 set; skipping submodule ` +
      `init. The voice engine WILL NOT BUILD until you unset this flag and ` +
      `run \`git submodule update --init --recursive ${submoduleRel}\`.`,
  );
  process.exit(0);
}

const res = spawnSync(
  "git",
  ["submodule", "update", "--init", "--recursive", submoduleRel],
  { cwd: repoRoot, stdio: "inherit" },
);
if (res.status !== 0) {
  console.error(
    `${LOG_PREFIX} error: \`git submodule update --init --recursive ` +
      `${submoduleRel}\` failed (exit ${res.status}).\n` +
      `\n` +
      `The omnivoice.cpp submodule is REQUIRED to build the local voice ` +
      `engine. Without it both \`build-omnivoice.mjs\` and the fused ` +
      `\`libelizainference\` build will fail.\n` +
      `\n` +
      `Common causes:\n` +
      `  - Offline / no network access to github.com\n` +
      `  - Authentication (SSO / SSH key) not configured for elizaOS\n` +
      `  - The pinned commit no longer exists upstream\n` +
      `\n` +
      `To bypass for an install that does NOT need voice (CI, headless ` +
      `text-only dev), set ELIZA_SKIP_OMNIVOICE_SUBMODULE=1 and re-run ` +
      `\`bun install\`. Voice features will be unavailable until you init ` +
      `the submodule manually.`,
  );
  process.exit(1);
}

if (
  !existsSync(join(submoduleAbs, ".git")) ||
  !existsSync(join(submoduleAbs, "CMakeLists.txt"))
) {
  console.error(
    `${LOG_PREFIX} error: \`git submodule update\` reported success but ` +
      `${submoduleRel} is still missing \`.git\` or \`CMakeLists.txt\`. ` +
      `The submodule may be pinned to a commit that no longer exists on ` +
      `the remote. Inspect \`.gitmodules\` and \`git ls-tree HEAD -- ` +
      `${submoduleRel}\`, then bump the gitlink to a valid upstream ` +
      `commit.`,
  );
  process.exit(1);
}

process.exit(0);

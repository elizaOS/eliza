#!/usr/bin/env node
/**
 * Ensure the in-repo omnivoice.cpp submodule
 * (plugins/plugin-local-inference/native/omnivoice.cpp,
 * elizaOS/omnivoice.cpp @ develop) is checked out.
 *
 * build-omnivoice.mjs probes for CMakeLists.txt in this submodule.
 * Idempotent and best-effort: exits cleanly when the submodule can't be
 * fetched (offline, older checkout without the .gitmodules entry, etc.).
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

if (
  existsSync(join(submoduleAbs, ".git")) &&
  existsSync(join(submoduleAbs, "CMakeLists.txt"))
) {
  process.exit(0);
}

if (!existsSync(gitmodules)) {
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

const res = spawnSync(
  "git",
  ["submodule", "update", "--init", "--recursive", submoduleRel],
  { cwd: repoRoot, stdio: "inherit" },
);
if (res.status !== 0) {
  console.warn(
    `[ensure-omnivoice-submodule] warning: \`git submodule update --init ` +
      `--recursive ${submoduleRel}\` failed (offline?). The omnivoice build ` +
      `script will need the submodule present to compile.`,
  );
}
process.exit(0);

#!/usr/bin/env node
/**
 * Ensure the in-repo opencode submodule is checked out.
 *
 * Path: vendor/opencode
 * Remote: https://github.com/elizaOS/opencode.git (branch: dev)
 *
 * plugin-agent-orchestrator runs opencode through the ACP path. The
 * bench-shim/opencode wrapper points acpx at this vendored source tree, and
 * OPENCODE_CONFIG_CONTENT is injected by AcpService when the selected agent is
 * opencode. If this submodule is absent the coding-agent surface still works
 * (Claude / Codex paths remain), but the vendored opencode path is unavailable.
 *
 * Behavior:
 *   - Submodule already initialized + package.json present → exit 0.
 *   - Submodule entry missing from .gitmodules → exit 0 (older checkouts
 *     pre-opencode gitlink should not be forced to update).
 *   - `git submodule update --init --recursive` fails → exit 1 with a
 *     clear, actionable error message.
 *   - ELIZA_SKIP_OPENCODE_SUBMODULE=1 → exit 0 with a single-line warning.
 *     Explicit escape hatch for CI / offline dev that doesn't need opencode.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const submoduleRel = join("vendor", "opencode");
const submoduleAbs = join(repoRoot, submoduleRel);
const gitmodules = join(repoRoot, ".gitmodules");
const LOG_PREFIX = "[ensure-opencode-submodule]";

if (
  existsSync(join(submoduleAbs, ".git")) &&
  existsSync(join(submoduleAbs, "package.json"))
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

if (process.env.ELIZA_SKIP_OPENCODE_SUBMODULE === "1") {
  console.warn(
    `${LOG_PREFIX} ELIZA_SKIP_OPENCODE_SUBMODULE=1 set; skipping submodule ` +
      `init. The opencode coding-agent path will be unavailable until you ` +
      `unset this flag and run \`git submodule update --init --recursive ${submoduleRel}\`.`,
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
      `The opencode submodule is needed for the opencode coding-agent path ` +
      `in plugin-agent-orchestrator. Claude and Codex paths are unaffected.\n` +
      `\n` +
      `Common causes:\n` +
      `  - Offline / no network access to github.com\n` +
      `  - Authentication not configured for elizaOS\n` +
      `  - The pinned commit no longer exists upstream\n` +
      `\n` +
      `To bypass, set ELIZA_SKIP_OPENCODE_SUBMODULE=1 and re-run ` +
      `\`bun install\`. The opencode agent path will be unavailable.`,
  );
  process.exit(1);
}

if (
  !existsSync(join(submoduleAbs, ".git")) ||
  !existsSync(join(submoduleAbs, "package.json"))
) {
  console.error(
    `${LOG_PREFIX} error: \`git submodule update\` reported success but ` +
      `${submoduleRel} is still missing \`.git\` or \`package.json\`. ` +
      `Inspect \`.gitmodules\` and \`git ls-tree HEAD -- ${submoduleRel}\`, ` +
      `then bump the gitlink to a valid upstream commit.`,
  );
  process.exit(1);
}

process.exit(0);

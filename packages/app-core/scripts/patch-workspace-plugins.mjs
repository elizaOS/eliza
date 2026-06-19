#!/usr/bin/env node
/**
 * Apply compatibility patches to workspace plugin submodules.
 *
 * These patches fix type errors introduced by @elizaos/core API changes that
 * haven't been merged upstream yet. Each patch is stored under
 * scripts/workspace-plugin-patches/ and applied idempotently via
 * `git apply --check` / `git apply`.
 *
 * Patches are skipped gracefully when:
 * - The submodule directory does not exist (not initialised yet)
 * - The patch has already been applied (git apply --check fails with "already applied")
 * - The upstream repo has fixed the issue (patch doesn't apply to current code)
 *
 * Remove a patch file once the corresponding elizaos-plugins PR is merged and
 * the eliza submodule pointer is bumped past it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolveRepoRootFromImportMeta(import.meta.url);
const patchDir = resolve(__dirname, "workspace-plugin-patches");

/**
 * Mapping from patch filename prefix → plugin submodule path (relative to repo root).
 * Convention: patch file is named `<plugin-name>-<description>.patch`.
 */
export const PLUGIN_PATCH_DIRS = {
  "plugin-anthropic": "eliza/plugins/plugin-anthropic",
  "plugin-google-genai": "eliza/plugins/plugin-google-genai",
  "plugin-agent-skills": "eliza/plugins/plugin-agent-skills",
};

export function resolvePluginDir(patchFile, { rootDir = root } = {}) {
  for (const [prefix, submodulePath] of Object.entries(PLUGIN_PATCH_DIRS)) {
    if (patchFile.startsWith(`${prefix}-`)) {
      return resolve(rootDir, submodulePath);
    }
  }
  return null;
}

function exec(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function applyPatch(patchPath, pluginDir) {
  const patchName = patchPath.split(/[\\/]/).pop();

  if (!existsSync(pluginDir)) {
    console.log(
      `[patch-workspace-plugins] Skipping ${patchName}: submodule not initialised`,
    );
    return "skipped";
  }

  try {
    exec("git", ["apply", "--check", "--reverse", patchPath], pluginDir);
    return "already-applied";
  } catch {
    // Not yet applied — proceed
  }

  // Check if patch applies cleanly
  try {
    exec("git", ["apply", "--check", patchPath], pluginDir);
  } catch (checkErr) {
    const msg = checkErr.stderr || checkErr.stdout || String(checkErr);
    console.warn(
      `[patch-workspace-plugins] ${patchName}: does not apply cleanly (upstream may have fixed it): ${msg.trim().slice(0, 200)}`,
    );
    return "inapplicable";
  }

  // Apply the patch
  try {
    exec("git", ["apply", patchPath], pluginDir);
    console.log(`[patch-workspace-plugins] ${patchName}: applied successfully`);
    return "applied";
  } catch (applyErr) {
    const msg = applyErr.stderr || applyErr.stdout || String(applyErr);
    console.error(
      `[patch-workspace-plugins] ERROR: failed to apply ${patchName}: ${msg.trim().slice(0, 400)}`,
    );
    return "failed";
  }
}

function run() {
  if (!existsSync(patchDir)) {
    console.log(
      "[patch-workspace-plugins] No patches directory found, skipping",
    );
    return;
  }

  let patches;
  try {
    patches = readdirSync(patchDir)
      .filter((f) => f.endsWith(".patch"))
      .sort();
  } catch {
    patches = [];
  }

  if (patches.length === 0) {
    console.log("[patch-workspace-plugins] No patch files found, skipping");
    return;
  }

  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const patchFile of patches) {
    const pluginDir = resolvePluginDir(patchFile);
    if (!pluginDir) {
      console.warn(
        `[patch-workspace-plugins] Cannot resolve plugin dir for ${patchFile}, skipping`,
      );
      skipped++;
      continue;
    }

    const patchPath = resolve(patchDir, patchFile);
    const result = applyPatch(patchPath, pluginDir);
    if (result === "applied") applied++;
    else if (result === "failed") failed++;
    else skipped++;
  }

  if (failed > 0) {
    console.error(
      `[patch-workspace-plugins] ${applied} applied, ${skipped} skipped, ${failed} FAILED`,
    );
    process.exit(1);
  }
}

run();

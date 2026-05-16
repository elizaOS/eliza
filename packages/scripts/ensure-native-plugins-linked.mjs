#!/usr/bin/env node
/**
 * Workaround for a Bun workspace bug: packages declared via the
 * `plugins/plugin-native-*` workspace glob (formerly
 * `packages/native-plugins/*`) are recognised by `bun pm ls` but
 * never symlinked into `node_modules/@elizaos/...`, even on a fresh
 * `bun install --ignore-scripts` against a deleted node_modules tree.
 *
 * Symptom downstream: `bun run --cwd packages/agent build:mobile`
 * fails with `Could not resolve: "@elizaos/capacitor-contacts"`
 * (and the other native-plugin packages) because the agent's
 * static imports can't be linked at bundle time.
 *
 * This script runs after `bun install` (wired into the root
 * `postinstall`) and explicitly creates the missing
 * `node_modules/@elizaos/<name>` → `../../plugins/plugin-native-<dir>`
 * symlinks. Idempotent: existing correct symlinks are left alone.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginsRoot = path.join(repoRoot, "plugins");
const nodeModulesRoots = [
  path.join(repoRoot, "node_modules"),
  path.join(repoRoot, "packages", "app", "node_modules"),
];

if (!existsSync(pluginsRoot)) {
  process.exit(0);
}

let linked = 0;
let alreadyOk = 0;
let skipped = 0;

for (const dirName of readdirSync(pluginsRoot)) {
  if (!dirName.startsWith("plugin-native-")) continue;
  const pkgDir = path.join(pluginsRoot, dirName);
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    skipped += 1;
    continue;
  }
  let pkgName;
  try {
    pkgName = JSON.parse(readFileSync(pkgJsonPath, "utf8")).name;
  } catch {
    skipped += 1;
    continue;
  }
  if (typeof pkgName !== "string" || pkgName.length === 0) {
    skipped += 1;
    continue;
  }

  for (const nodeModulesRoot of nodeModulesRoots) {
    if (!existsSync(nodeModulesRoot)) continue;
    const targetDir = path.join(nodeModulesRoot, ...pkgName.split("/"));
    const parentDir = path.dirname(targetDir);
    // Relative path from the symlink location to the workspace dir, so the
    // symlink keeps working if node_modules is moved with the repo (it
    // shouldn't be, but a stable target is more portable than an absolute
    // /Users/... path).
    const relativeTarget = path.relative(parentDir, pkgDir);

    // Already a correct symlink? Leave it.
    let needLink = true;
    if (existsSync(targetDir)) {
      try {
        const stat = lstatSync(targetDir);
        if (stat.isSymbolicLink()) {
          const currentTarget = realpathSync(targetDir);
          const expectedTarget = realpathSync(pkgDir);
          if (currentTarget === expectedTarget) {
            needLink = false;
            alreadyOk += 1;
          } else {
            rmSync(targetDir, { recursive: true, force: true });
          }
        } else {
          // Real directory at the same path — bun installed something
          // unrelated under the same name. Leave it; printing here would
          // surface a real conflict.
          skipped += 1;
          continue;
        }
      } catch {
        // Stat failure — fall through to (re)create.
        try {
          rmSync(targetDir, { recursive: true, force: true });
        } catch {}
      }
    }

    if (needLink) {
      mkdirSync(parentDir, { recursive: true });
      try {
        symlinkSync(relativeTarget, targetDir, "dir");
        linked += 1;
      } catch (err) {
        console.error(
          `[ensure-native-plugins-linked] failed to link ${pkgName} → ${pkgDir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}

if (linked > 0) {
  console.log(
    `[ensure-native-plugins-linked] linked ${linked} workspace package(s); ${alreadyOk} already in place; ${skipped} skipped.`,
  );
}

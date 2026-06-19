#!/usr/bin/env node
/**
 * Ensure native plugin compatibility links exist after a Bun install.
 *
 * Native plugins now live at `plugins/plugin-native-*`, but several build and
 * packaging paths still need the historical `packages/native/plugins/<name>`
 * layout. Bun can also miss workspace links when installs run with
 * --ignore-scripts, so mirror the package-name links into the node_modules roots
 * that desktop/mobile builds resolve from.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NATIVE_PLUGIN_PREFIX = "plugin-native-";
const PLUGINS_ROOT = join(REPO_ROOT, "plugins");
const LEGACY_NATIVE_PLUGINS_ROOT = join(
  REPO_ROOT,
  "packages",
  "native",
  "plugins",
);
const NODE_MODULES_DIRS = ["node_modules", "packages/app/node_modules"];

function readPackageJson(pluginDir) {
  try {
    return JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function discoverNativePlugins() {
  if (!existsSync(PLUGINS_ROOT)) return [];

  return readdirSync(PLUGINS_ROOT, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(NATIVE_PLUGIN_PREFIX),
    )
    .map((entry) => {
      const dir = join(PLUGINS_ROOT, entry.name);
      const pkg = readPackageJson(dir);
      return {
        dir,
        legacyName: entry.name.slice(NATIVE_PLUGIN_PREFIX.length),
        packageName: typeof pkg?.name === "string" ? pkg.name : null,
      };
    })
    .filter((plugin) => plugin.packageName?.startsWith("@elizaos/"));
}

function sameRealPath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function ensureDirSymlink(linkPath, targetDir) {
  const existing = lstatSync(linkPath, { throwIfNoEntry: false });
  if (existing) {
    if (sameRealPath(linkPath, targetDir)) return "skipped";

    if (!existing.isSymbolicLink()) {
      return "conflict";
    }

    try {
      unlinkSync(linkPath);
    } catch {
      return "conflict";
    }
  }

  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(relative(dirname(linkPath), targetDir), linkPath, "dir");
  return "created";
}

function main() {
  const plugins = discoverNativePlugins();
  const created = [];
  const skipped = [];
  const conflicts = [];
  const missingRoots = [];

  for (const plugin of plugins) {
    const legacyLink = join(LEGACY_NATIVE_PLUGINS_ROOT, plugin.legacyName);
    const legacyResult = ensureDirSymlink(legacyLink, plugin.dir);
    if (legacyResult === "created") {
      created.push(`packages/native/plugins/${plugin.legacyName}`);
    } else if (legacyResult === "skipped") {
      skipped.push(`packages/native/plugins/${plugin.legacyName}`);
    } else {
      conflicts.push(`packages/native/plugins/${plugin.legacyName}`);
    }

    for (const root of NODE_MODULES_DIRS) {
      const nodeModulesRoot = join(REPO_ROOT, root);
      if (!existsSync(nodeModulesRoot)) {
        missingRoots.push(root);
        continue;
      }

      const packageLink = join(nodeModulesRoot, plugin.packageName);
      const packageResult = ensureDirSymlink(packageLink, plugin.dir);
      if (packageResult === "created") {
        created.push(`${root}/${plugin.packageName}`);
      } else if (packageResult === "skipped") {
        skipped.push(`${root}/${plugin.packageName}`);
      } else {
        conflicts.push(`${root}/${plugin.packageName}`);
      }
    }
  }

  const missingUnique = new Set(missingRoots);
  console.log(
    `[ensure-native-plugins-linked] plugins=${plugins.length} created=${created.length} skipped=${skipped.length} conflicts=${conflicts.length} missing-roots=${missingUnique.size}`,
  );

  for (const conflict of conflicts) {
    console.warn(
      `[ensure-native-plugins-linked] existing non-symlink or unreadable path left unchanged: ${conflict}`,
    );
  }
}

main();

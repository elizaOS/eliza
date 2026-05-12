#!/usr/bin/env node

/**
 * Link standalone elizaOS plugin source checkouts into Eliza's
 * node_modules tree as local workspace links — without adding them to
 * any package.json as a dependency.
 *
 * Motivation: the user has the plugin-imessage source checked out at
 * ~/src/plugin-imessage/typescript and wants to develop against it
 * locally, but doesn't want to publish it to npm, doesn't want it
 * pinned in package.json (which would break CI and fresh clones that
 * don't have the sibling source), and doesn't want `bun install` to
 * clobber the symlink. This script recreates the links on every
 * postinstall pass so they survive dependency resolution.
 *
 * Extend EXTERNAL_PLUGIN_SOURCES to link additional standalone plugins.
 * Entries whose source directory doesn't exist are silently skipped —
 * this keeps the script safe for fresh clones or CI boxes that don't
 * have the sibling checkout.
 *
 * This file intentionally reuses `createPackageLink` from
 * setup-upstreams.mjs so the same symlink semantics (relative
 * symlink on POSIX, junction on Windows, idempotent replace) apply.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";
import { createPackageLink } from "./setup-upstreams.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = resolveRepoRootFromImportMeta(import.meta.url);

/**
 * Standalone plugin source directories to link into node_modules. Each
 * entry points at a directory containing a `package.json` whose `name`
 * field starts with `@elizaos/` or `@elizaos/`. Paths may be absolute
 * or relative to the repo root. Missing paths are skipped.
 */
export const EXTERNAL_PLUGIN_SOURCES = [
  // plugin-imessage — two-way iMessage connector. Prefer the submodule
  // at eliza/plugins/plugin-imessage; fall back to a sibling source checkout
  // at ~/src/plugin-imessage for independent PR development.
  path.resolve(
    DEFAULT_REPO_ROOT,
    "eliza",
    "plugins",
    "plugin-imessage",
    "typescript",
  ),
  path.resolve(DEFAULT_REPO_ROOT, "..", "src", "plugin-imessage", "typescript"),
];

/**
 * The three node_modules locations where Eliza expects `@elizaos/*`
 * packages to resolve from — matches the list used by
 * setup-upstreams.mjs so dynamic imports work from every entry
 * point (root CLI, apps/app Vite shell, apps/home dashboard).
 */
function linkTargetsFor(repoRoot, scope, basename) {
  return [
    path.join(repoRoot, "node_modules", scope, basename),
    path.join(repoRoot, "apps", "app", "node_modules", scope, basename),
    path.join(repoRoot, "apps", "home", "node_modules", scope, basename),
  ];
}

function readPackageName(pkgDir) {
  const pkgPath = path.join(pkgDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkgJson = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return typeof pkgJson.name === "string" ? pkgJson.name : null;
  } catch {
    return null;
  }
}

function splitScoped(name) {
  if (!name.startsWith("@")) return null;
  const slash = name.indexOf("/");
  if (slash === -1) return null;
  return { scope: name.slice(0, slash), basename: name.slice(slash + 1) };
}

export function linkExternalPlugins(
  repoRoot = DEFAULT_REPO_ROOT,
  sources = EXTERNAL_PLUGIN_SOURCES,
) {
  let linked = 0;
  let skipped = 0;

  for (const sourceDir of sources) {
    if (!existsSync(sourceDir)) {
      skipped += 1;
      continue;
    }

    const name = readPackageName(sourceDir);
    if (!name) {
      console.warn(
        `[link-external-plugins] ${sourceDir} has no package.json name field — skipping`,
      );
      skipped += 1;
      continue;
    }

    const parts = splitScoped(name);
    if (!parts) {
      console.warn(
        `[link-external-plugins] ${name} is not a scoped package — skipping`,
      );
      skipped += 1;
      continue;
    }

    for (const linkPath of linkTargetsFor(
      repoRoot,
      parts.scope,
      parts.basename,
    )) {
      if (createPackageLink(linkPath, sourceDir)) {
        linked += 1;
      }
    }

    // Bun's ESM resolver traverses the **real** path of a symlinked
    // package, not the symlink location, when walking up to find
    // dependencies. Workspace-linked plugins live outside Eliza's
    // tree, so `import "@elizaos/core"` from their dist/ walks up
    // through ~/src/…/typescript/node_modules and finds nothing.
    // `patch-deps.mjs` earlier removed the nested @elizaos/core from
    // workspace-linked plugins to avoid version skew; we re-create it
    // here as a symlink back to the repo root core. This way the
    // plugin's resolver finds a single canonical core regardless of
    // which path traversal strategy Bun uses.
    const pluginCoreLink = path.join(
      sourceDir,
      "node_modules",
      "@elizaos",
      "core",
    );
    const rootCore = path.join(repoRoot, "node_modules", "@elizaos", "core");
    if (existsSync(rootCore)) {
      try {
        mkdirSync(path.dirname(pluginCoreLink), { recursive: true });
        // Replace whatever is there (dir, broken link, stale file).
        try {
          unlinkSync(pluginCoreLink);
        } catch {
          // ignore missing
        }
        symlinkSync(rootCore, pluginCoreLink, "dir");
      } catch (err) {
        console.warn(
          `[link-external-plugins] failed to link @elizaos/core into ${sourceDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (linked === 0 && skipped === 0) {
    return { linked, skipped };
  }

  if (linked > 0) {
    console.log(
      `[link-external-plugins] Linked ${linked} external plugin ${linked === 1 ? "entry" : "entries"}`,
    );
  }

  return { linked, skipped };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  try {
    linkExternalPlugins();
  } catch (error) {
    console.error(
      `[link-external-plugins] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

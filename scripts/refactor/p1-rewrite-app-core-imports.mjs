#!/usr/bin/env bun
// P1b — Rewrite all imports of @elizaos/app-core/<subpath> to their new homes
// after p1a moved the files. Reads the migration manifest written by p1a.
//
// The codemod handles:
//   - Static imports:   import X from "@elizaos/app-core/foo"
//   - Side-effect:      import "@elizaos/app-core/foo"
//   - Dynamic:          await import("@elizaos/app-core/foo")
//   - require:          require("@elizaos/app-core/foo")
//   - Re-exports:       export * from "@elizaos/app-core/foo"
//
// What it does NOT handle (logged MANUAL):
//   - Dynamic specifiers built from variables (`import(`@elizaos/app-core/${name}`)`)
//   - String literals in non-import positions (e.g. config files that name modules)
//   - CSS @source paths

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  REPO_ROOT,
  Stats,
  makeLogger,
  parseFlags,
  preflight,
  rewriteImports,
  walkSourceFiles,
  writeFileIfChanged,
} from "./lib/util.mjs";

const MANIFEST_PATH = "/tmp/refactor-p1-manifest.json";

const APP_CORE_PREFIX = "@elizaos/app-core";

// Anything in app-core/src that DIDN'T move (i.e. node-side code) collapses
// into the barrel `@elizaos/app-core` (no subpaths).
//
// The mapping logic:
//   1. Build prefix-rewrite table from manifest:
//        "packages/app-core/src/components/Foo.tsx" → "packages/ui/src/components/Foo.tsx"
//      becomes
//        "@elizaos/app-core/components/Foo" → "@elizaos/ui/components/Foo"
//   2. Anything else under @elizaos/app-core/<subpath> (not in the manifest)
//      collapses to "@elizaos/app-core" (the barrel).

async function main() {
  const flags = parseFlags();
  const log = makeLogger(flags);
  preflight("p1-rewrite-app-core-imports", flags, log);
  const stats = new Stats();

  if (!existsSync(MANIFEST_PATH)) {
    log.error(
      `Manifest not found at ${MANIFEST_PATH}. Provide the P1a move manifest (file moves) before running this import-rewrite step.`,
    );
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  log.info(`manifest: ${manifest.length} moves`);

  // Build subpath rewrite table.
  // "packages/app-core/src/components/foo.tsx" → "@elizaos/app-core/components/foo"
  // "packages/ui/src/components/foo.tsx"        → "@elizaos/ui"
  /** @type {Record<string, string>} */
  const subpathRewrites = {};
  for (const entry of manifest) {
    const oldSpec = repoPathToSpecifier(entry.from);
    const newSpec = entry.to.endsWith(".css")
      ? repoPathToAssetSpecifier(entry.to)
      : repoPathToBarePackageSpecifier(entry.to);
    if (oldSpec && newSpec) {
      subpathRewrites[oldSpec] = newSpec;
    }
  }

  log.section("Sample of subpath rewrites");
  const sample = Object.entries(subpathRewrites).slice(0, 10);
  for (const [from, to] of sample) log.info(`  ${from} → ${to}`);
  if (Object.keys(subpathRewrites).length > sample.length) {
    log.info(`  …and ${Object.keys(subpathRewrites).length - sample.length} more`);
  }

  log.section("Codemod sweep");
  const files = walkSourceFiles(REPO_ROOT, (path) => {
    return !path.includes(`${REPO_ROOT}/scripts/refactor/`);
  });
  log.info(`scanning ${files.length} source files`);

  let changedFiles = 0;
  let totalRewrites = 0;
  let collapsed = 0;
  const manualReview = [];

  for (const file of files) {
    const before = readFileSync(file, "utf8");
    const { source, changes, manual } = rewriteAppCoreImports(before, subpathRewrites);
    if (manual.length > 0) {
      for (const note of manual) {
        manualReview.push({ file: relative(REPO_ROOT, file), note });
      }
    }
    if (changes.rewrites === 0 && changes.collapses === 0) continue;
    writeFileIfChanged(file, source, flags, log);
    changedFiles++;
    totalRewrites += changes.rewrites;
    collapsed += changes.collapses;
  }

  stats.incr("files modified", changedFiles);
  stats.incr("subpath rewrites (to ui/shared)", totalRewrites);
  stats.incr("subpath collapses (to barrel)", collapsed);

  log.section("Update @elizaos/ui and @elizaos/shared barrels");
  updateDestinationBarrels(manifest, flags, log, stats);

  if (manualReview.length > 0) {
    log.section("MANUAL review needed");
    for (const m of manualReview.slice(0, 50)) {
      log.manual(`${m.file}: ${m.note}`);
    }
    if (manualReview.length > 50) {
      log.manual(`…and ${manualReview.length - 50} more`);
    }
    stats.incr("manual review items", manualReview.length);
  }

  stats.print(log);
}

/**
 * Turn a repo-relative source-file path into the @elizaos/<pkg>/<subpath>
 * import specifier it provides. Strips `src/`, `index.ts*`, and the file ext.
 *
 * "packages/app-core/src/components/Foo.tsx" → "@elizaos/app-core/components/Foo"
 * "packages/app-core/src/state/index.ts"     → "@elizaos/app-core/state"
 */
function repoPathToSpecifier(repoPath) {
  // Strip leading "packages/" or "plugins/"
  const m = /^packages\/([^/]+)\/src\/(.+)$/.exec(repoPath);
  if (!m) return null;
  const pkgFolder = m[1];
  let subpath = m[2];
  // Strip extension
  subpath = subpath.replace(/\.(tsx?|jsx?|mts|cts|mjs)$/, "");
  // Strip /index suffix → resolves to the directory specifier
  subpath = subpath.replace(/\/index$/, "");
  // Map folder name to package scope. We assume @elizaos/<folder>.
  const pkgName = `@elizaos/${pkgFolder}`;
  return subpath ? `${pkgName}/${subpath}` : pkgName;
}

function repoPathToBarePackageSpecifier(repoPath) {
  const m = /^packages\/([^/]+)\/src(?:\/|$)/.exec(repoPath);
  if (!m) return null;
  if (m[1] === "ui") return "@elizaos/ui";
  if (m[1] === "shared") return "@elizaos/shared";
  return `@elizaos/${m[1]}`;
}

function repoPathToAssetSpecifier(repoPath) {
  const m = /^packages\/([^/]+)\/src\/(.+)$/.exec(repoPath);
  if (!m) return null;
  const pkgFolder = m[1];
  return `@elizaos/${pkgFolder}/${m[2]}`;
}

/**
 * Apply the import rewrite logic to one source string.
 * Returns { source, changes: { rewrites, collapses }, manual: string[] }.
 */
function rewriteAppCoreImports(source, subpathRewrites) {
  const manual = [];
  let rewrites = 0;
  let collapses = 0;

  const result = rewriteImports(source, (spec) => {
    if (!spec.startsWith(APP_CORE_PREFIX)) return null;
    if (spec === APP_CORE_PREFIX) return null; // already barrel
    if (spec === `${APP_CORE_PREFIX}/package.json`) return null;

    // Try exact subpath match first.
    if (subpathRewrites[spec]) {
      rewrites++;
      return subpathRewrites[spec];
    }

    // Try prefix matches: "@elizaos/app-core/components/Foo/Bar" matches
    // "@elizaos/app-core/components/Foo" if Foo is a folder we moved.
    for (const [old, next] of Object.entries(subpathRewrites)) {
      if (spec.startsWith(`${old}/`)) {
        rewrites++;
        return spec.replace(old, next);
      }
    }

    // Not in manifest → collapse to barrel `@elizaos/app-core`.
    // This is correct ONLY if the symbol is re-exported from app-core's
    // index.ts barrel. The collapse happens regardless; if a symbol isn't
    // in the barrel, the build will fail loudly and we add it.
    collapses++;
    return APP_CORE_PREFIX;
  });

  // Detect dynamic-string imports that we can't safely rewrite.
  const dynStringRe = /import\s*\(\s*[`"'][^`"']*\$\{[^}]+\}[^`"']*[`"']\s*\)/g;
  let m;
  while ((m = dynStringRe.exec(source)) !== null) {
    if (m[0].includes(APP_CORE_PREFIX)) {
      manual.push(`dynamic specifier: ${m[0].slice(0, 80)}`);
    }
  }

  return {
    source: result.source,
    changes: { rewrites, collapses },
    manual,
  };
}

function updateDestinationBarrels(manifest, flags, log, stats) {
  const byPackage = new Map([
    [
      "packages/ui/src/index.ts",
      new Set(),
    ],
    [
      "packages/shared/src/index.ts",
      new Set(),
    ],
  ]);

  for (const entry of manifest) {
    const target = entry.to;
    const pkgRoot = target.startsWith("packages/ui/src/")
      ? "packages/ui/src"
      : target.startsWith("packages/shared/src/")
        ? "packages/shared/src"
        : null;
    if (!pkgRoot) continue;
    if (!/\.(tsx?|jsx?|mts|cts|mjs)$/.test(target)) continue;
    const barrel = `${pkgRoot}/index.ts`;
    let rel = target.slice(`${pkgRoot}/`.length);
    rel = rel.replace(/\.(tsx?|jsx?|mts|cts|mjs)$/, "");
    rel = rel.replace(/\/index$/, "");
    if (!rel || rel === "index") continue;
    byPackage.get(barrel)?.add(`export * from "./${rel}";`);
  }

  for (const [barrelRel, exportLines] of byPackage.entries()) {
    if (exportLines.size === 0) continue;
    const barrelAbs = join(REPO_ROOT, barrelRel);
    if (!existsSync(barrelAbs)) {
      log.manual(`${barrelRel} missing; cannot add package barrel exports`);
      continue;
    }
    const before = readFileSync(barrelAbs, "utf8");
    const additions = [...exportLines]
      .sort()
      .filter((line) => !before.includes(line));
    if (additions.length === 0) {
      log.info(`${barrelRel}: moved exports already covered`);
      continue;
    }
    const next = [
      before.trimEnd(),
      "",
      "// Added by scripts/refactor/p1-rewrite-app-core-imports.mjs.",
      "// Re-export moved app-core modules so consumers can import the package barrel.",
      ...additions,
      "",
    ].join("\n");
    writeFileIfChanged(barrelAbs, next, flags, log);
    stats.incr("barrel export lines added", additions.length);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

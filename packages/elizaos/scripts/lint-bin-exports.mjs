#!/usr/bin/env node
/**
 * Static guard for CLI package `bin` entries that import dependency subpaths
 * blocked by published `exports` maps.
 *
 * Globally installed bins run in strict Node ESM resolution, so this scans each
 * workspace package's bin source and checks bare dependency subpath imports
 * against the resolved dependency package metadata. It is a focused lead for
 * launch-time regressions, not a full bundler proof.
 *
 * Usage: node scripts/lint-bin-exports.mjs [repoRoot]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(scriptDir, "..", "..", "..");

const packagesDir = path.join(repoRoot, "packages");

/** @returns {string[]} absolute paths to every packages/<name>/package.json */
function findPackageJsons() {
  if (!fs.existsSync(packagesDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(packagesDir)) {
    const pkgPath = path.join(packagesDir, name, "package.json");
    if (fs.existsSync(pkgPath)) out.push(pkgPath);
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Normalize a `bin` field to a list of relative file paths. */
function binFiles(bin) {
  if (!bin) return [];
  if (typeof bin === "string") return [bin];
  return Object.values(bin);
}

/**
 * Extract bare-specifier subpath imports from source: `foo/sub`, `@scope/pkg/sub`.
 * Ignores relative imports and bare package roots (those always resolve).
 * @returns {{specifier: string, pkg: string, subpath: string}[]}
 */
function extractSubpathImports(source) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) specifiers.add(match[1]);
  }

  const results = [];
  for (const spec of specifiers) {
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    if (spec.startsWith("node:")) continue;
    const segs = spec.split("/");
    const pkg = spec.startsWith("@") ? `${segs[0]}/${segs[1]}` : segs[0];
    const rest = spec.slice(pkg.length);
    if (rest === "" || rest === "/") continue; // bare root always resolves
    results.push({ specifier: spec, pkg, subpath: `.${rest}` });
  }
  return results;
}

/** Resolve a dependency package's package.json from a consuming file's dir. */
function resolveDepPackageJson(fromDir, pkg) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", pkg, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Does `exports` permit `subpath` (e.g. "./sub/path.js")? A missing exports
 * map means the package is fully open (legacy), so it permits everything.
 */
function exportsPermits(exportsField, subpath) {
  if (exportsField === undefined || exportsField === null) return true;
  if (typeof exportsField === "string")
    return subpath === "." || subpath === "./";
  if (typeof exportsField !== "object") return true;

  const keys = Object.keys(exportsField);
  const isSubpathMap = keys.some((k) => k === "." || k.startsWith("./"));
  if (!isSubpathMap) return true; // conditions-only map = single "." entry

  for (const key of keys) {
    if (key === subpath) return true;
    if (key.includes("*")) {
      const [pre, post] = key.split("*");
      if (
        subpath.startsWith(pre) &&
        subpath.endsWith(post) &&
        subpath.length >= pre.length + post.length
      ) {
        return true;
      }
    }
  }
  return false;
}

const violations = [];
let checkedBins = 0;

for (const pkgJsonPath of findPackageJsons()) {
  const pkgDir = path.dirname(pkgJsonPath);
  let pkg;
  try {
    pkg = readJson(pkgJsonPath);
  } catch {
    continue;
  }

  for (const binRel of binFiles(pkg.bin)) {
    const binFile = path.join(pkgDir, binRel);
    if (!fs.existsSync(binFile)) {
      // Bin points at a build artifact (e.g. ./dist/cli.js). Skip silently when
      // unbuilt — the packaged smoke test covers the built bin end-to-end.
      continue;
    }
    checkedBins += 1;
    const source = fs.readFileSync(binFile, "utf8");
    for (const imp of extractSubpathImports(source)) {
      const depPkgJson = resolveDepPackageJson(pkgDir, imp.pkg);
      if (!depPkgJson) continue; // unresolved (peer/optional/unbuilt); skip
      const depPkg = readJson(depPkgJson);
      if (!exportsPermits(depPkg.exports, imp.subpath)) {
        violations.push(
          `${path.relative(repoRoot, binFile)}: imports "${imp.specifier}" but ` +
            `"${imp.pkg}" exports map does not whitelist subpath "${imp.subpath}" ` +
            `(would throw ERR_PACKAGE_PATH_NOT_EXPORTED on global install)`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("bin-exports lint failed:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(`bin-exports lint passed (${checkedBins} bin file(s) checked)`);

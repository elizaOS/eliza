#!/usr/bin/env node
// Static guard for the elizaOS/eliza#8000 bug class: a `bin`-listed entry
// imports a deep subpath (e.g. `@elizaos/cli/dist/index.js`) that the target
// package's `exports` map does not whitelist. Under a global install Node uses
// the strict ESM resolver and throws ERR_PACKAGE_PATH_NOT_EXPORTED, so the CLI
// dies before doing anything. Local installs and bundlers often hide it.
//
// This walks every `packages/*/package.json`, follows each `bin` target plus
// the files it transitively imports inside the same package, collects every
// bare import specifier of the form `pkg/subpath` or `@scope/pkg/subpath`, and
// asserts the resolved package's `exports` map permits that subpath. Anything
// it cannot resolve to a workspace package is skipped (external deps own their
// own contracts).
//
// Usage:
//   node packages/scripts/audit-bin-export-subpaths.mjs           # report
//   node packages/scripts/audit-bin-export-subpaths.mjs --check    # exit 1 on violation
//   node packages/scripts/audit-bin-export-subpaths.mjs --json     # machine-readable

import fs from "node:fs";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const check = args.has("--check");

const repoRoot = process.cwd();
const packagesDir = path.join(repoRoot, "packages");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listWorkspacePackages() {
  const result = new Map(); // name -> { dir, pkg }
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(packagesDir, entry.name, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;
    const pkg = readJson(pkgJsonPath);
    if (!pkg.name) continue;
    result.set(pkg.name, {
      name: pkg.name,
      dir: path.join(packagesDir, entry.name),
      pkg,
    });
  }
  return result;
}

// Parse a bare import specifier into { pkgName, subpath } where subpath
// includes the leading "/" (or "" for the package root). Returns null for
// relative/builtin/absolute specifiers.
function splitSpecifier(specifier) {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:")
  ) {
    return null;
  }
  const parts = specifier.split("/");
  let pkgName;
  let rest;
  if (specifier.startsWith("@")) {
    if (parts.length < 2) return null;
    pkgName = `${parts[0]}/${parts[1]}`;
    rest = parts.slice(2);
  } else {
    pkgName = parts[0];
    rest = parts.slice(1);
  }
  const subpath = rest.length ? `./${rest.join("/")}` : ".";
  return { pkgName, subpath };
}

// Collect every static/dynamic import specifier from a source file.
function extractSpecifiers(source) {
  const specifiers = new Set();
  // import ... from 'x' | export ... from 'x' | import 'x'
  const staticRe =
    /(?:import|export)(?:[\s\S]*?\sfrom)?\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g;
  // import('x') | require('x')
  const dynamicRe = /(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticRe, dynamicRe]) {
    let match;
    while ((match = re.exec(source)) !== null) {
      const spec = match[1] ?? match[2];
      if (spec) specifiers.add(spec);
    }
  }
  return specifiers;
}

// Walk the bin file and the same-package files it transitively imports,
// returning the set of cross-package specifiers encountered.
function collectCrossPackageSpecifiers(binFile, packageDir) {
  const crossPackage = new Set();
  const visited = new Set();
  const queue = [binFile];
  while (queue.length) {
    const file = queue.shift();
    const resolved = resolveLocalFile(file);
    if (!resolved || visited.has(resolved)) continue;
    visited.add(resolved);
    if (!resolved.startsWith(packageDir)) continue; // stay inside this package
    let source;
    try {
      source = fs.readFileSync(resolved, "utf8");
    } catch {
      continue;
    }
    for (const spec of extractSpecifiers(source)) {
      if (spec.startsWith(".")) {
        queue.push(path.resolve(path.dirname(resolved), spec));
      } else {
        crossPackage.add(spec);
      }
    }
  }
  return crossPackage;
}

const FILE_EXTS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"];

function resolveLocalFile(file) {
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  for (const ext of FILE_EXTS) {
    if (fs.existsSync(file + ext)) return file + ext;
  }
  for (const ext of FILE_EXTS) {
    const indexFile = path.join(file, `index${ext}`);
    if (fs.existsSync(indexFile)) return indexFile;
  }
  return null;
}

// Does the target package's exports map permit `subpath`? Mirrors Node's
// coarse subpath-matching: exact key, or a "./*" pattern whose prefix/suffix
// bracket the subpath. No `exports` => legacy resolution allows any file.
function exportsPermit(targetPkg, subpath) {
  const exportsField = targetPkg.exports;
  if (exportsField === undefined) return true; // legacy: any internal file allowed
  if (typeof exportsField === "string") {
    return subpath === ".";
  }
  const keys = Object.keys(exportsField);
  // If no keys look like subpaths (all are conditions like "import"/"types"),
  // the map only describes the "." entry.
  const subpathKeys = keys.filter((k) => k === "." || k.startsWith("./"));
  if (subpathKeys.length === 0) {
    return subpath === ".";
  }
  for (const key of subpathKeys) {
    if (key === subpath) return true;
    if (key.includes("*")) {
      const [prefix, suffix] = key.split("*");
      if (
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix) &&
        subpath.length >= prefix.length + suffix.length
      ) {
        return true;
      }
    }
  }
  return false;
}

function main() {
  const workspace = listWorkspacePackages();
  const violations = [];
  const checked = [];

  for (const { name, dir, pkg } of workspace.values()) {
    if (!pkg.bin) continue;
    const binTargets =
      typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin);
    for (const binRel of binTargets) {
      const binFile = path.resolve(dir, binRel);
      const specifiers = collectCrossPackageSpecifiers(binFile, dir);
      for (const spec of specifiers) {
        const split = splitSpecifier(spec);
        if (!split) continue;
        if (split.pkgName === name) continue; // self
        const target = workspace.get(split.pkgName);
        if (!target) continue; // external package owns its own contract
        if (split.subpath === ".") continue; // bare import always fine
        checked.push({ owner: name, bin: binRel, specifier: spec });
        if (!exportsPermit(target.pkg, split.subpath)) {
          violations.push({
            owner: name,
            bin: binRel,
            specifier: spec,
            targetPackage: split.pkgName,
            subpath: split.subpath,
          });
        }
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ checked, violations }, null, 2));
  } else if (violations.length === 0) {
    console.log(
      `bin-export-subpaths: ${checked.length} cross-package bin import(s) checked, no violations.`,
    );
  } else {
    console.error(
      `bin-export-subpaths: ${violations.length} disallowed subpath import(s) (ERR_PACKAGE_PATH_NOT_EXPORTED risk):`,
    );
    for (const v of violations) {
      console.error(
        `  - ${v.owner} bin ${v.bin} imports "${v.specifier}" but ${v.targetPackage} exports does not permit "${v.subpath}"`,
      );
    }
  }

  if (check && violations.length > 0) {
    process.exit(1);
  }
}

main();

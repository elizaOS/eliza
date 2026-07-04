#!/usr/bin/env node
/**
 * Audit the build / typecheck compiler model (issue #9626, TL;DR #3 + "two
 * compilers"). The repo's chosen model is: **tsgo checks, tsc only emits.**
 *
 * This script flags drift from that model across every workspace package:
 *   1. A `build` that runs a full `tsc` type-check (declaration emit WITHOUT
 *      `--noCheck`) while a separate `typecheck` already checks the same source
 *      — a redundant second full type-check.
 *   2. A `typecheck` that uses `tsc` instead of the standard `tsgo`.
 *   3. A no-op `typecheck` (`tsc --noEmit --noCheck` checks nothing).
 *
 * Exits non-zero on any un-allowlisted violation so it can gate CI / `verify`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildModelExceptions } from "./lib/script-metadata.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const WORKSPACE_GLOBS = ["packages", "plugins"];

// Deliberate, documented exceptions to the "tsgo checks, tsc emits" model. Each
// package opts in via `elizaos.scripts.buildModel` in its own package.json (e.g.
// @elizaos/core / plugin-streaming keep a full build type-check for byte-stable
// declaration emit; plugin-social-alpha / plugin-personal-assistant stay on
// `tsc` for typecheck pending a tsgo fix, #9626). Resolved through the discovery
// seam so no package names live in this file.
const ALLOW = resolveBuildModelExceptions({ repoRoot });

const CUSTOM_PLUGIN_BUILD_ALLOW = new Map([
  [
    "plugins/plugin-app-manager/build.ts",
    "custom declaration emit flags for allowImportingTsExtensions/rootDir",
  ],
  [
    "plugins/plugin-benchmarks/build.ts",
    "legacy tolerant declaration fallback pending tsconfig output cleanup",
  ],
  [
    "plugins/plugin-computeruse/build.ts",
    "multiple published entrypoints plus parallel declaration emit",
  ],
  [
    "plugins/plugin-elizacloud/build.ts",
    "subpath export build and dist/src flattening",
  ],
  [
    "plugins/plugin-local-inference/build.ts",
    "multi-entry runtime package with post-build import smoke checks",
  ],
  ["plugins/plugin-sql/src/build.ts", "nested plugin-sql package layout"],
  [
    "plugins/plugin-video/build.ts",
    "custom declaration directory flags against tsconfig.json",
  ],
  ["plugins/plugin-vision/build.ts", "node bundle plus CJS worker build"],
  [
    "plugins/plugin-wallet/build.ts",
    "multi-entry wallet build with .mjs/.d.mts publication rules",
  ],
  [
    "plugins/plugin-wallet/src/chains/evm/build.ts",
    "nested chain build without its own package.json",
  ],
  [
    "plugins/plugin-wallet/src/chains/solana/build.ts",
    "nested chain build without its own package.json",
  ],
]);

function listPackageDirs() {
  const dirs = [];
  for (const glob of WORKSPACE_GLOBS) {
    const base = path.join(repoRoot, glob);
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(base, ent.name);
      try {
        statSync(path.join(dir, "package.json"));
        dirs.push(dir);
      } catch {
        // nested workspace (e.g. packages/feed/packages/*) — descend one level
        try {
          const nestedBase = path.join(dir, "packages");
          for (const nested of readdirSync(nestedBase, {
            withFileTypes: true,
          })) {
            if (!nested.isDirectory()) continue;
            const ndir = path.join(nestedBase, nested.name);
            try {
              statSync(path.join(ndir, "package.json"));
              dirs.push(ndir);
            } catch {}
          }
        } catch {}
      }
    }
  }
  return dirs;
}

function walkBuildFiles(base, out = []) {
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (
      ent.name === "node_modules" ||
      ent.name === "dist" ||
      ent.name === ".turbo" ||
      ent.name === "vendor"
    ) {
      continue;
    }
    const full = path.join(base, ent.name);
    if (ent.isDirectory()) {
      walkBuildFiles(full, out);
    } else if (/^build\.(ts|mjs)$/.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

function listBuildFiles() {
  return ["packages", "plugins"]
    .flatMap((dir) => walkBuildFiles(path.join(repoRoot, dir)))
    .sort();
}

function nearestPackageName(filePath) {
  let dir = path.dirname(filePath);
  while (dir.startsWith(repoRoot)) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        return JSON.parse(readFileSync(manifest, "utf8")).name;
      } catch {
        return null;
      }
    }
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

/** A tsc invocation that emits declarations and does NOT skip the type-check. */
function isFullTscEmit(script) {
  if (!/\btsc\b/.test(script)) return false;
  const emits =
    /--emitDeclarationOnly|--declaration\b/.test(script) ||
    /(?:^|[\s"',])(?:-p|--project)(?:[\s"',]+)tsconfig/.test(script);
  if (!emits) return false;
  if (/--noCheck/.test(script)) return false;
  // `--noEmit` means a pure check (no emit) — UNLESS it's `--noEmit false`,
  // which re-enables emit to override a tsconfig `noEmit: true`. So
  // `tsc --emitDeclarationOnly --noEmit false` (no --noCheck) is still a full
  // type-check that emits, and must be flagged.
  if (/--noEmit\b(?!\s+false)/.test(script)) return false;
  return true;
}

const violations = [];
const turbo = JSON.parse(
  readFileSync(path.join(repoRoot, "turbo.json"), "utf8"),
);
for (const taskName of ["typecheck", "lint", "lint:check"]) {
  const deps = turbo.tasks?.[taskName]?.dependsOn ?? [];
  if (deps.includes("^build")) {
    violations.push(
      `turbo ${taskName}: generic task depends on ^build; keep typecheck/lint source-first and add explicit package overrides only where dist is required`,
    );
  }
}

for (const dir of listPackageDirs()) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const name = pkg.name ?? path.relative(repoRoot, dir);
  const scripts = pkg.scripts ?? {};
  const build = scripts.build ?? "";
  const typecheck = scripts.typecheck ?? "";
  const hasSeparateTypecheck = /\btsgo\b|\btsc\b/.test(typecheck);

  if (
    isFullTscEmit(build) &&
    hasSeparateTypecheck &&
    !ALLOW.doubleCheck.has(name)
  ) {
    violations.push(
      `${name}: build double-type-checks (add --noCheck to its tsc emit) — ${build.trim()}`,
    );
  } else if (hasSeparateTypecheck && !ALLOW.doubleCheck.has(name)) {
    // The build script may delegate to a build.ts/build.mjs that runs tsc
    // internally — inspect those files for a tsc emit without --noCheck.
    for (const buildFile of ["build.ts", "build.mjs"]) {
      if (!new RegExp(`\\b${buildFile.replace(".", "\\.")}\\b`).test(build))
        continue;
      let body;
      try {
        body = readFileSync(path.join(dir, buildFile), "utf8");
      } catch {
        continue;
      }
      for (const line of body.split("\n")) {
        if (/^\s*(\/\/|\*)/.test(line)) continue; // skip comments
        if (isFullTscEmit(line)) {
          violations.push(
            `${name}: ${buildFile} runs a full tsc type-check (add --noCheck) — ${line.trim()}`,
          );
          break;
        }
      }
    }
  }
  if (/\btsc --noEmit\b/.test(typecheck) && /--noCheck/.test(typecheck)) {
    violations.push(
      `${name}: typecheck is a no-op (\`tsc --noEmit --noCheck\` checks nothing)`,
    );
  } else if (
    /\btsc\b/.test(typecheck) &&
    /--noEmit/.test(typecheck) &&
    !/\btsgo\b/.test(typecheck) &&
    !ALLOW.tscTypecheck.has(name)
  ) {
    // `tsc -b` (project-references build) is a deliberately different mode and
    // is intentionally not flagged here — only the `tsc --noEmit` checker form.
    violations.push(
      `${name}: typecheck uses tsc --noEmit, not tsgo — ${typecheck.trim()}`,
    );
  }
}

for (const file of listBuildFiles()) {
  const rel = path.relative(repoRoot, file);
  const body = readFileSync(file, "utf8");
  const owner = nearestPackageName(file);
  if (!ALLOW.doubleCheck.has(owner)) {
    for (const line of body.split("\n")) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      if (isFullTscEmit(line)) {
        violations.push(
          `${rel}: build script runs declaration emit without --noCheck — ${line.trim()}`,
        );
        break;
      }
    }
  }

  if (
    rel.startsWith("plugins/") &&
    /\/build\.ts$/.test(rel) &&
    !/import\s+\{\s*buildPlugin\s*\}\s+from\s+["']\.\.\/plugin-build/.test(
      body,
    ) &&
    (/\bBun\.build\b/.test(body) ||
      /\bbuild\(\s*\{/.test(body) ||
      /import\s+\{\s*build\s*\}\s+from\s+["']bun["']/.test(body))
  ) {
    const reason = CUSTOM_PLUGIN_BUILD_ALLOW.get(rel);
    if (!reason) {
      violations.push(
        `${rel}: custom Bun build should use plugins/plugin-build.ts or be added to CUSTOM_PLUGIN_BUILD_ALLOW with a package-specific reason`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(
    `[audit-build-typecheck] ${violations.length} compiler-model violation(s):\n`,
  );
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error(
    "\nModel: tsgo checks, tsc emits. Add --noCheck to emit-only tsc builds; use tsgo for typecheck.",
  );
  process.exit(1);
}
console.log(
  "[audit-build-typecheck] ✓ build/typecheck compiler model is consistent",
);

#!/usr/bin/env node
/**
 * Audit the build / typecheck compiler model (issue #9626, TL;DR #3 + "two
 * compilers"). The repo's chosen model is: **stable tsc checks, compatibility tsc6 emits.**
 *
 * This script flags drift from that model across every workspace package:
 *   1. A `build` that runs a full `tsc6` type-check (declaration emit WITHOUT
 *      `--noCheck`) while a separate `typecheck` already checks the same source
 *      — a redundant second full type-check.
 *   2. A `typecheck` that uses compatibility `tsc6` instead of stable `tsc`.
 *   3. A no-op `typecheck` (`tsc --noEmit --noCheck` checks nothing).
 *
 * Exits non-zero on any un-allowlisted violation so it can gate CI / `verify`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildModelExceptions } from "./lib/script-metadata.mjs";
import { resolveWorkspacePackageDirs } from "./lib/workspace-package-dirs.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const rootPackage = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const workspaceGlobs = rootPackage.workspaces;

// Deliberate, documented exceptions to the stable-native checker model. Build
// and declaration emit may remain on TypeScript 6 while stable native checks
// resolve through the @typescript/native package alias.
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

export function listPackageDirs(root = repoRoot, globs = workspaceGlobs) {
  return resolveWorkspacePackageDirs(root, globs);
}

export function walkBuildFiles(base, out = []) {
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

export function listBuildFiles(root = repoRoot) {
  return ["packages", "plugins"]
    .flatMap((dir) => walkBuildFiles(path.join(root, dir)))
    .sort();
}

export function nearestPackageName(filePath, root = repoRoot) {
  let dir = path.dirname(filePath);
  while (dir.startsWith(root)) {
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

/** A compatibility tsc6 invocation that emits and does not skip checking. */
export function isFullTscEmit(script) {
  if (!/\btsc6\b/.test(script)) return false;
  const emits =
    /--emitDeclarationOnly|--declaration\b/.test(script) ||
    /(?:^|[\s"',])(?:-p|--project)(?:[\s"',]+)tsconfig/.test(script);
  if (!emits) return false;
  if (/--noCheck/.test(script)) return false;
  // `--noEmit` means a pure check (no emit) — UNLESS it's `--noEmit false`,
  // which re-enables emit to override a tsconfig `noEmit: true`. So
  // `tsc6 --emitDeclarationOnly --noEmit false` (no --noCheck) is still a
  // full type-check that emits, and must be flagged.
  if (/--noEmit\b(?!\s+false)/.test(script)) return false;
  return true;
}

export function auditBuildTypecheck(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const rootPkg =
    options.rootPackage ??
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const globs = options.workspaceGlobs ?? rootPkg.workspaces;
  const allow =
    options.allow ?? resolveBuildModelExceptions({ repoRoot: root });
  const violations = [];

  if (rootPkg.devDependencies?.["@typescript/native-preview"]) {
    violations.push("root still depends on retired @typescript/native-preview");
  }
  if (
    !/^npm:typescript@\^?7\./.test(
      rootPkg.devDependencies?.["@typescript/native"] ?? "",
    )
  ) {
    violations.push("root @typescript/native alias is not stable TypeScript 7");
  }
  if (!rootPkg.devDependencies?.["@typescript/typescript6"]) {
    violations.push("root is missing the TypeScript 6 compatibility package");
  }

  const turbo =
    options.turbo ??
    JSON.parse(readFileSync(path.join(root, "turbo.json"), "utf8"));
  for (const taskName of ["typecheck", "lint", "lint:check"]) {
    const deps = turbo.tasks?.[taskName]?.dependsOn ?? [];
    if (deps.includes("^build")) {
      violations.push(
        `turbo ${taskName}: generic task depends on ^build; keep typecheck/lint source-first and add explicit package overrides only where dist is required`,
      );
    }
  }

  for (const dir of options.packageDirs ?? listPackageDirs(root, globs)) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const name = pkg.name ?? path.relative(root, dir);
    const scripts = pkg.scripts ?? {};
    const build = scripts.build ?? "";
    const typecheck = scripts.typecheck ?? "";
    const hasSeparateTypecheck = /\btsc6?\b/.test(typecheck);
    const nativeTypeScript =
      pkg.dependencies?.["@typescript/native"] ??
      pkg.devDependencies?.["@typescript/native"];

    if (/\btsgo\b/.test(typecheck)) {
      violations.push(`${name}: typecheck still invokes retired tsgo`);
    }
    if (
      /\btsc\b/.test(typecheck) &&
      !/^npm:typescript@\^?7\./.test(nativeTypeScript ?? "")
    ) {
      violations.push(
        `${name}: native typecheck does not declare the stable @typescript/native alias`,
      );
    }

    if (
      isFullTscEmit(build) &&
      hasSeparateTypecheck &&
      !allow.doubleCheck.has(name)
    ) {
      violations.push(
        `${name}: build double-type-checks (add --noCheck to its tsc6 emit) — ${build.trim()}`,
      );
    } else if (hasSeparateTypecheck && !allow.doubleCheck.has(name)) {
      // A build script may delegate to build.ts/build.mjs, so inspect it for a
      // compatibility declaration emit that omits --noCheck.
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
              `${name}: ${buildFile} runs a full tsc6 type-check (add --noCheck) — ${line.trim()}`,
            );
            break;
          }
        }
      }
    }
    if (/\btsc6? --noEmit\b/.test(typecheck) && /--noCheck/.test(typecheck)) {
      violations.push(
        `${name}: typecheck is a no-op (\`tsc --noEmit --noCheck\` checks nothing)`,
      );
    } else if (
      /\btsc6\b/.test(typecheck) &&
      /--noEmit/.test(typecheck) &&
      !allow.tscTypecheck.has(name)
    ) {
      // `tsc6 -b` is a deliberately different mode. Only compatibility
      // `tsc6 --noEmit` is a checker-model violation here.
      violations.push(
        `${name}: typecheck uses compatibility tsc6 --noEmit, not stable tsc — ${typecheck.trim()}`,
      );
    }
  }

  for (const file of options.buildFiles ?? listBuildFiles(root)) {
    const rel = path.relative(root, file);
    const body = readFileSync(file, "utf8");
    const owner = nearestPackageName(file, root);
    if (!allow.doubleCheck.has(owner)) {
      for (const line of body.split("\n")) {
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        if (isFullTscEmit(line)) {
          violations.push(
            `${rel}: build script runs tsc6 declaration emit without --noCheck — ${line.trim()}`,
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

  return violations;
}

export function runAuditBuildTypecheck(options = {}) {
  const violations = auditBuildTypecheck(options);
  if (violations.length > 0) {
    console.error(
      `[audit-build-typecheck] ${violations.length} compiler-model violation(s):\n`,
    );
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      "\nModel: stable tsc checks, compatibility tsc6 emits. Add --noCheck to emit-only tsc6 builds; use tsc for typecheck.",
    );
    return 1;
  }
  console.log(
    "[audit-build-typecheck] ✓ build/typecheck compiler model is consistent",
  );
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(runAuditBuildTypecheck());
}

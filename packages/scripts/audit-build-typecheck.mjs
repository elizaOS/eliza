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
  if (!/\btsc6\b|resolveTscBin\(\)/.test(script)) return false;
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

function executableBuildStatements(source) {
  const withoutCommentLines = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
  const resolverAliases = [
    ...withoutCommentLines.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*resolveTscBin\(\)/g,
    ),
  ].map((match) => match[1]);
  let normalized = withoutCommentLines;
  for (const alias of resolverAliases) {
    normalized = normalized.replace(new RegExp(`\\b${alias}\\b`, "g"), "tsc6");
  }
  return normalized
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function findFullTscEmit(source) {
  return (
    executableBuildStatements(source).find((statement) =>
      isFullTscEmit(statement),
    ) ?? null
  );
}

function isEffectiveTypecheck(script) {
  if (/\btsc6?\b/.test(script)) return true;
  if (/\btypecheck-workspace\.(?:js|mjs|ts)\b/.test(script)) return true;
  return /\b(?:bun|npm|pnpm|yarn)(?:\s+run)?(?:\s+--cwd\s+\S+)?\s+typecheck\b/.test(
    script,
  );
}

function isExplicitNoSourceTypecheck(script) {
  return /^\s*echo\b.*\bno TypeScript source files to check\b/i.test(script);
}

function normalizeExceptionMap(exceptions) {
  if (exceptions instanceof Map) return exceptions;
  // Set input is retained only for dependency-injected tests written against
  // the former shape; production metadata always resolves package-owned Maps.
  return new Map(
    [...(exceptions ?? [])].map((packageName) => [
      packageName,
      "test-provided exception",
    ]),
  );
}

export function analyzeBuildTypecheck(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const rootPkg =
    options.rootPackage ??
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const globs = options.workspaceGlobs ?? rootPkg.workspaces;
  const resolvedAllow =
    options.allow ?? resolveBuildModelExceptions({ repoRoot: root });
  const allow = {
    doubleCheck: normalizeExceptionMap(resolvedAllow.doubleCheck),
    tscTypecheck: normalizeExceptionMap(resolvedAllow.tscTypecheck),
    invalid: resolvedAllow.invalid ?? [],
  };
  const usedExceptions = {
    doubleCheck: new Set(),
    tscTypecheck: new Set(),
  };
  const packageDirs = options.packageDirs ?? listPackageDirs(root, globs);
  const buildFiles = options.buildFiles ?? listBuildFiles(root);
  const counts = {
    declared: packageDirs.length,
    scanned: 0,
    typechecked: 0,
    excepted: 0,
  };
  const violations = [];

  violations.push(...allow.invalid);

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

  for (const dir of packageDirs) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    counts.scanned += 1;
    const name = pkg.name ?? path.relative(root, dir);
    const scripts = pkg.scripts ?? {};
    const build = scripts.build ?? "";
    const typecheck = scripts.typecheck ?? "";
    const hasSeparateTypecheck = isEffectiveTypecheck(typecheck);
    if (hasSeparateTypecheck) counts.typechecked += 1;
    if (
      typecheck.trim().length > 0 &&
      !hasSeparateTypecheck &&
      !isExplicitNoSourceTypecheck(typecheck)
    ) {
      violations.push(
        `${name}: typecheck script is not a recognized compiler or delegated typecheck lane — ${typecheck.trim()}`,
      );
    }
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

    if (isFullTscEmit(build) && hasSeparateTypecheck) {
      if (allow.doubleCheck.has(name)) {
        usedExceptions.doubleCheck.add(name);
      } else {
        violations.push(
          `${name}: build double-type-checks (add --noCheck to its tsc6 emit) — ${build.trim()}`,
        );
      }
    } else if (hasSeparateTypecheck) {
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
        const fullEmit = findFullTscEmit(body);
        if (fullEmit) {
          if (allow.doubleCheck.has(name)) {
            usedExceptions.doubleCheck.add(name);
          } else {
            violations.push(
              `${name}: ${buildFile} runs a full tsc6 type-check (add --noCheck) — ${fullEmit.replace(/\s+/g, " ")}`,
            );
          }
        }
      }
    }
    if (/\btsc6? --noEmit\b/.test(typecheck) && /--noCheck/.test(typecheck)) {
      violations.push(
        `${name}: typecheck is a no-op (\`tsc --noEmit --noCheck\` checks nothing)`,
      );
    } else if (/\btsc6\b/.test(typecheck) && /--noEmit/.test(typecheck)) {
      // `tsc6 -b` is a deliberately different mode. Only compatibility
      // `tsc6 --noEmit` is a checker-model violation here.
      if (allow.tscTypecheck.has(name)) {
        usedExceptions.tscTypecheck.add(name);
      } else {
        violations.push(
          `${name}: typecheck uses compatibility tsc6 --noEmit, not stable tsc — ${typecheck.trim()}`,
        );
      }
    }
  }

  for (const file of buildFiles) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const body = readFileSync(file, "utf8");
    const owner = nearestPackageName(file, root);
    const fullEmit = findFullTscEmit(body);
    if (fullEmit) {
      if (allow.doubleCheck.has(owner)) {
        usedExceptions.doubleCheck.add(owner);
      } else {
        violations.push(
          `${rel}: build script runs tsc6 declaration emit without --noCheck — ${fullEmit.replace(/\s+/g, " ")}`,
        );
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

  for (const key of ["doubleCheck", "tscTypecheck"]) {
    for (const [name, reason] of allow[key]) {
      if (!usedExceptions[key].has(name)) {
        violations.push(
          `${name}: stale buildModel.${key} exception is not exercised — ${reason}`,
        );
      }
    }
  }
  counts.excepted = new Set([
    ...usedExceptions.doubleCheck,
    ...usedExceptions.tscTypecheck,
  ]).size;

  return { violations, counts };
}

export function auditBuildTypecheck(options = {}) {
  return analyzeBuildTypecheck(options).violations;
}

function formatCounts(counts) {
  return `declared=${counts.declared} scanned=${counts.scanned} typechecked=${counts.typechecked} excepted=${counts.excepted}`;
}

export function runAuditBuildTypecheck(options = {}) {
  const { violations, counts } = analyzeBuildTypecheck(options);
  console.log(`[audit-build-typecheck] ${formatCounts(counts)}`);
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

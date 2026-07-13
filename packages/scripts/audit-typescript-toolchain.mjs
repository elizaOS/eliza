#!/usr/bin/env node

/**
 * Repository-wide TypeScript toolchain contract.
 *
 * This audit intentionally starts from `git ls-files`, rather than the root
 * workspace globs. The repository contains independently installable examples,
 * templates, nested apps, and benchmark SDKs that are not all Bun workspaces;
 * they still need to move with a compiler migration.
 *
 * Contract:
 *   - every direct `typescript` dependency is the exact native compiler version;
 *   - the superseded native-preview package and its `tsgo` executable are gone;
 *   - callers resolve the exported TypeScript package metadata instead of
 *     reaching into private `bin/` or `lib/` compiler paths;
 *   - the temporary TypeScript 6 compiler API is available only through the
 *     named `@typescript/legacy-api` alias and only to reviewed source files.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TYPESCRIPT_VERSION = "7.0.2";
export const LEGACY_API_SPEC = "npm:@typescript/typescript6@6.0.2";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;
const PACKAGE_JSON_RE = /(?:^|\/)package\.json$/;
const HARDCODED_COMPILER_PATH_RE =
  /typescript[\\/]+(?:bin[\\/]+tsc(?:\.js)?|lib[\\/]+tsc(?:\.js)?)/i;

/**
 * TypeScript 7.0 ships the native compiler but not the old JavaScript compiler
 * API. These reviewed consumers still need the side-by-side TypeScript 6 API.
 * Keeping this list file-level (instead of allowing whole packages) makes any
 * new compatibility dependency an explicit review decision.
 */
export const APPROVED_LEGACY_API_CONSUMERS = new Map([
  ["scripts/assert-comment-only-diff.mjs", "package.json"],
  ["packages/scripts/alias-read-guard.mjs", "package.json"],
  ["packages/scripts/audit-action-availability.mjs", "package.json"],
  [
    "packages/scripts/audit-capability-router-plugin-surface.ts",
    "package.json",
  ],
  ["packages/scripts/audit-ui-determinism.mjs", "package.json"],
  ["packages/scripts/check-scenario-workflow-coverage.mjs", "package.json"],
  ["packages/scripts/error-policy-ratchet.mjs", "package.json"],
  ["packages/scripts/type-duplication-audit.mjs", "package.json"],
  ["packages/scripts/type-safety-ratchet.mjs", "package.json"],
  ["packages/scripts/voice-policy-ratchet.mjs", "package.json"],
  [
    "packages/agent/src/services/plugin-compiler.ts",
    "packages/agent/package.json",
  ],
  [
    "packages/app-core/scripts/ensure-generated-core-proto-js.mjs",
    "packages/app-core/package.json",
  ],
  [
    "packages/app-core/scripts/find-collisions.mjs",
    "packages/app-core/package.json",
  ],
  [
    "packages/app-core/scripts/lib/patch-bun-exports.mjs",
    "packages/app-core/package.json",
  ],
  [
    "packages/app-core/scripts/smoke-view-declarations.mjs",
    "packages/app-core/package.json",
  ],
  [
    "packages/app-core/scripts/type-audit.mjs",
    "packages/app-core/package.json",
  ],
  [
    "packages/cloud/shared/scripts/check-tenant-scope.ts",
    "packages/cloud/shared/package.json",
  ],
  [
    "packages/cloud/services/operator/scripts/typescript-legacy-api-hook.cjs",
    "packages/cloud/services/operator/package.json",
  ],
  [
    "packages/core/src/__tests__/service-type-collisions.test.ts",
    "packages/core/package.json",
  ],
  [
    "packages/core/src/contracts/core-plugin-coupling.contract.test.ts",
    "packages/core/package.json",
  ],
  [
    "packages/examples/agent-console/action-scanner.ts",
    "packages/examples/agent-console/package.json",
  ],
  [
    "packages/feed/packages/testing/unit/web/api-routes-with-error-handling.test.ts",
    "packages/feed/packages/testing/package.json",
  ],
  [
    "packages/scenario-runner/src/action-effect-ratchet.test.ts",
    "packages/scenario-runner/package.json",
  ],
  [
    "packages/scenario-runner/src/corpus-assertion-guard.test.ts",
    "packages/scenario-runner/package.json",
  ],
  [
    "packages/scenario-runner/src/loader.ts",
    "packages/scenario-runner/package.json",
  ],
  [
    "packages/scenario-runner/src/skippable-check-ratchet.test.ts",
    "packages/scenario-runner/package.json",
  ],
]);

function normalizePath(file) {
  return file.split(path.sep).join("/").replace(/^\.\//, "");
}

function moduleSpecifiers(source) {
  const specifiers = [];
  const re =
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(re)) specifiers.push(match[1]);
  return specifiers;
}

function isExecutableTsgo(command) {
  // Package scripts are shell programs. Inspect command positions after shell
  // control operators, skipping environment assignments and common wrappers.
  // This deliberately does not flag data arguments such as `classify tsgo`.
  for (const rawSegment of command.split(/&&|\|\||[;|\n]/)) {
    let segment = rawSegment.trim().replace(/^\(+\s*/, "");
    segment = segment.replace(/^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)\s+)*/, "");
    segment = segment.replace(/^(?:(?:command|exec|env)\s+)*/, "");
    segment = segment.replace(/^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)\s+)*/, "");
    if (/^tsgo(?=$|\s)/.test(segment)) return true;
    if (
      /^(?:(?:bunx|npx)|bun\s+(?:x|run)|npm\s+exec|pnpm\s+exec)\s+tsgo(?=$|\s)/.test(
        segment,
      )
    ) {
      return true;
    }
  }
  return false;
}

function dependencyEntries(manifest) {
  const entries = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest?.[field];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const [name, spec] of Object.entries(dependencies)) {
      entries.push({ field, name, spec });
    }
  }
  return entries;
}

function addViolation(violations, file, message) {
  violations.push({ file, message });
}

/**
 * Audit already-loaded tracked files. This is pure over `entries`, making the
 * contract regression-testable without creating a temporary Git repository.
 */
export function auditTypeScriptToolchain(entries) {
  const normalizedEntries = entries
    .map((entry) => ({ ...entry, path: normalizePath(entry.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const violations = [];
  const manifests = new Map();
  const usedLegacyApi = new Set();

  for (const entry of normalizedEntries) {
    if (!PACKAGE_JSON_RE.test(entry.path)) continue;
    let manifest;
    try {
      manifest = JSON.parse(entry.text);
      manifests.set(entry.path, manifest);
    } catch (error) {
      addViolation(
        violations,
        entry.path,
        `invalid package.json: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    for (const { field, name, spec } of dependencyEntries(manifest)) {
      if (name === "typescript" && spec !== TYPESCRIPT_VERSION) {
        addViolation(
          violations,
          entry.path,
          `${field}.typescript must be exactly ${TYPESCRIPT_VERSION}, found ${JSON.stringify(spec)}`,
        );
      }

      if (name === "@typescript/native-preview") {
        addViolation(
          violations,
          entry.path,
          `${field} still depends on superseded @typescript/native-preview`,
        );
      }

      if (name === "@typescript/typescript6") {
        addViolation(
          violations,
          entry.path,
          `${field} must alias the compatibility API as @typescript/legacy-api`,
        );
      }

      if (
        name !== "@typescript/legacy-api" &&
        typeof spec === "string" &&
        spec.startsWith("npm:@typescript/typescript6@")
      ) {
        addViolation(
          violations,
          entry.path,
          `${field}.${name} aliases TypeScript 6 under an unapproved name; use @typescript/legacy-api`,
        );
      }

      if (name === "@typescript/legacy-api") {
        if (spec !== LEGACY_API_SPEC) {
          addViolation(
            violations,
            entry.path,
            `${field}.@typescript/legacy-api must be exactly ${LEGACY_API_SPEC}, found ${JSON.stringify(spec)}`,
          );
        }
        if (![...APPROVED_LEGACY_API_CONSUMERS.values()].includes(entry.path)) {
          addViolation(
            violations,
            entry.path,
            "declares @typescript/legacy-api but is not an approved compatibility owner",
          );
        }
      }
    }

    for (const [scriptName, command] of Object.entries(
      manifest.scripts ?? {},
    )) {
      if (typeof command !== "string") continue;
      if (command.includes("@typescript/native-preview")) {
        addViolation(
          violations,
          entry.path,
          `scripts.${scriptName} invokes superseded @typescript/native-preview`,
        );
      }
      if (isExecutableTsgo(command)) {
        addViolation(
          violations,
          entry.path,
          `scripts.${scriptName} invokes removed tsgo; use TypeScript 7's tsc`,
        );
      }
      if (HARDCODED_COMPILER_PATH_RE.test(command)) {
        addViolation(
          violations,
          entry.path,
          `scripts.${scriptName} hardcodes a private TypeScript compiler path`,
        );
      }
    }
  }

  for (const entry of normalizedEntries) {
    if (!SOURCE_FILE_RE.test(entry.path)) continue;

    // Restrict this check to quoted path strings. Documentation comments may
    // describe the forbidden subpath, but executable code must not resolve it.
    const quotedStrings = entry.text.match(/["'`][^"'`\r\n]*["'`]/g) ?? [];
    if (quotedStrings.some((value) => HARDCODED_COMPILER_PATH_RE.test(value))) {
      addViolation(
        violations,
        entry.path,
        "hardcodes a private TypeScript compiler path; resolve typescript/package.json and its bin entry",
      );
    }

    for (const specifier of moduleSpecifiers(entry.text)) {
      if (specifier === "@typescript/legacy-api") {
        const owner = APPROVED_LEGACY_API_CONSUMERS.get(entry.path);
        if (!owner) {
          addViolation(
            violations,
            entry.path,
            "imports @typescript/legacy-api but is not an approved compiler-API consumer",
          );
        } else {
          usedLegacyApi.add(owner);
        }
        continue;
      }

      if (
        specifier === "typescript" ||
        (specifier.startsWith("typescript/") &&
          specifier !== "typescript/package.json") ||
        specifier === "@typescript/typescript6" ||
        specifier.startsWith("@typescript/typescript6/")
      ) {
        addViolation(
          violations,
          entry.path,
          `imports ${JSON.stringify(specifier)} directly; compiler-API consumers must use @typescript/legacy-api`,
        );
      }
    }
  }

  for (const manifestPath of usedLegacyApi) {
    const manifest = manifests.get(manifestPath);
    const declaration = dependencyEntries(manifest).find(
      ({ name }) => name === "@typescript/legacy-api",
    );
    if (!declaration) {
      addViolation(
        violations,
        manifestPath,
        `approved compiler-API consumers require @typescript/legacy-api at ${LEGACY_API_SPEC}`,
      );
    }
  }

  violations.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.message.localeCompare(b.message),
  );
  return {
    violations,
    stats: {
      trackedFiles: normalizedEntries.length,
      packageJsonFiles: normalizedEntries.filter((entry) =>
        PACKAGE_JSON_RE.test(entry.path),
      ).length,
      sourceFiles: normalizedEntries.filter((entry) =>
        SOURCE_FILE_RE.test(entry.path),
      ).length,
      legacyApiConsumers: [...usedLegacyApi].length,
    },
  };
}

export function listTrackedFiles(root = repoRoot) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .sort((a, b) => a.localeCompare(b));
}

export function auditTrackedRepository(root = repoRoot) {
  const trackedFiles = listTrackedFiles(root);
  const relevantFiles = trackedFiles.filter(
    (file) => PACKAGE_JSON_RE.test(file) || SOURCE_FILE_RE.test(file),
  );
  const entries = relevantFiles.map((file) => ({
    path: file,
    text: readFileSync(path.join(root, file), "utf8"),
  }));
  const result = auditTypeScriptToolchain(entries);
  result.stats.trackedFiles = trackedFiles.length;
  return result;
}

export function main() {
  const { violations, stats } = auditTrackedRepository();
  if (violations.length > 0) {
    console.error(
      `[audit-typescript-toolchain] ${violations.length} violation(s):`,
    );
    for (const violation of violations) {
      console.error(`  ✗ ${violation.file}: ${violation.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `[audit-typescript-toolchain] ✓ TypeScript ${TYPESCRIPT_VERSION}; audited ${stats.packageJsonFiles} package manifests and ${stats.sourceFiles} source files (${stats.trackedFiles} tracked files total)`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

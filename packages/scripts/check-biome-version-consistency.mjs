/**
 * Enforces one Biome version across workspace declarations, schemas, and tracked lockfiles.
 * Formatting commands run this first so dependency updates cannot validate with a stale override.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIOME_PACKAGE = "@biomejs/biome";
const DEPENDENCY_GROUPS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const PLATFORM_PACKAGES = [
  "@biomejs/cli-darwin-arm64",
  "@biomejs/cli-darwin-x64",
  "@biomejs/cli-linux-arm64",
  "@biomejs/cli-linux-arm64-musl",
  "@biomejs/cli-linux-x64",
  "@biomejs/cli-linux-x64-musl",
  "@biomejs/cli-win32-arm64",
  "@biomejs/cli-win32-x64",
];

function readJsonObject(repoRoot, relativePath) {
  const parsed = JSON.parse(
    readFileSync(path.join(repoRoot, relativePath), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${relativePath} must contain a JSON object`);
  }
  return parsed;
}

function trackedFiles(repoRoot, pathspec) {
  return execFileSync("git", ["ls-files", "-z", "--", pathspec], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function dependencyVersion(manifest, groupName) {
  const group = manifest[groupName];
  if (typeof group !== "object" || group === null || Array.isArray(group)) {
    return undefined;
  }
  const version = group[BIOME_PACKAGE];
  return typeof version === "string" ? version : undefined;
}

function collectLockVersions(lockText) {
  const versions = [];
  const declarationPattern =
    /"@biomejs\/(?:biome|cli-[a-z0-9-]+)"\s*:\s*"(\d+\.\d+\.\d+)"/g;
  const resolutionPattern =
    /@biomejs\/(?:biome|cli-[a-z0-9-]+)@(\d+\.\d+\.\d+)/g;
  for (const match of lockText.matchAll(declarationPattern)) {
    versions.push(match[1]);
  }
  for (const match of lockText.matchAll(resolutionPattern)) {
    versions.push(match[1]);
  }
  return versions;
}

export function collectBiomeVersionProblems(
  repoRoot,
  { packageFiles, configFiles, lockFiles } = {},
) {
  const problems = [];
  const rootManifest = readJsonObject(repoRoot, "package.json");
  const canonicalVersion = dependencyVersion(rootManifest, "devDependencies");
  if (!canonicalVersion || !/^\d+\.\d+\.\d+$/.test(canonicalVersion)) {
    return [
      `package.json: ${BIOME_PACKAGE} must be pinned to an exact semantic version`,
    ];
  }

  const overrideVersion = dependencyVersion(rootManifest, "overrides");
  if (overrideVersion !== canonicalVersion) {
    problems.push(
      `package.json overrides: ${overrideVersion ?? "missing"} (expected ${canonicalVersion})`,
    );
  }

  const manifests = packageFiles ?? trackedFiles(repoRoot, "*package.json");
  for (const relativePath of manifests) {
    const manifest = readJsonObject(repoRoot, relativePath);
    for (const groupName of DEPENDENCY_GROUPS) {
      const declaredVersion = dependencyVersion(manifest, groupName);
      if (declaredVersion && declaredVersion !== canonicalVersion) {
        problems.push(
          `${relativePath} ${groupName}: ${declaredVersion} (expected ${canonicalVersion})`,
        );
      }
    }
  }

  const expectedSchema = `https://biomejs.dev/schemas/${canonicalVersion}/schema.json`;
  const configs = configFiles ?? trackedFiles(repoRoot, "*biome.json");
  for (const relativePath of configs) {
    const schema = readJsonObject(repoRoot, relativePath).$schema;
    if (schema !== expectedSchema) {
      problems.push(
        `${relativePath} schema: ${typeof schema === "string" ? schema : "missing"} (expected ${expectedSchema})`,
      );
    }
  }

  const locks = lockFiles ?? trackedFiles(repoRoot, "*bun.lock");
  for (const relativePath of locks) {
    const candidate = readFileSync(path.join(repoRoot, relativePath), "utf8");
    if (!candidate.includes("@biomejs/")) continue;
    const lockVersions = collectLockVersions(candidate);
    if (lockVersions.length === 0) {
      problems.push(
        `${relativePath}: Biome is declared but has no pinned declaration or resolution`,
      );
    }
    for (const version of new Set(lockVersions)) {
      if (version !== canonicalVersion) {
        problems.push(
          `${relativePath}: resolved Biome version ${version} (expected ${canonicalVersion})`,
        );
      }
    }
  }

  const lockText = readFileSync(path.join(repoRoot, "bun.lock"), "utf8");
  const lockOverrideBlock = lockText.match(
    /"overrides"\s*:\s*\{([\s\S]*?)\}\s*,\s*"packages"\s*:/,
  )?.[1];
  const lockOverride = lockOverrideBlock?.match(
    /"@biomejs\/biome"\s*:\s*"([^"]+)"/,
  )?.[1];
  if (lockOverride !== canonicalVersion) {
    problems.push(
      `bun.lock override: ${lockOverride ?? "missing"} (expected ${canonicalVersion})`,
    );
  }

  const biomeResolution = `"@biomejs/biome": ["@biomejs/biome@${canonicalVersion}"`;
  if (!lockText.includes(biomeResolution)) {
    problems.push(
      `bun.lock: missing ${BIOME_PACKAGE}@${canonicalVersion} resolution`,
    );
  }
  for (const platformPackage of PLATFORM_PACKAGES) {
    const optionalDependency = `"${platformPackage}": "${canonicalVersion}"`;
    if (!lockText.includes(optionalDependency)) {
      problems.push(
        `bun.lock: missing ${platformPackage} optional dependency at ${canonicalVersion}`,
      );
    }
    const resolution = `"${platformPackage}": ["${platformPackage}@${canonicalVersion}"`;
    if (!lockText.includes(resolution)) {
      problems.push(
        `bun.lock: missing ${platformPackage}@${canonicalVersion} resolution`,
      );
    }
  }

  return problems;
}

export function assertBiomeVersionConsistency(repoRoot) {
  const problems = collectBiomeVersionProblems(repoRoot);
  if (problems.length > 0) {
    throw new Error(
      `Biome version consistency failed:\n- ${problems.join("\n- ")}`,
    );
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const repoRoot = path.resolve(path.dirname(scriptPath), "../..");
  try {
    assertBiomeVersionConsistency(repoRoot);
    process.stdout.write("Biome version consistency passed.\n");
  } catch (error) {
    // error-policy:J1 the CLI translates consistency failures into a non-zero process result
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
/**
 * Validates and selects the credentialed scenario shards consumed by the live
 * GitHub Actions authority. The checked-in manifest is shared with the coverage
 * gate so manual shard selection cannot diverge from scheduled catalog coverage.
 */

import { appendFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const LIVE_SCENARIO_MANIFEST_PATH = path.join(
  REPO_ROOT,
  "packages",
  "scripts",
  "live-scenario-shards.json",
);

const EXPECTED_SCHEMA = "eliza_live_scenario_shards_v1";
const EXPECTED_AUTHORITY = ".github/workflows/live-scenarios.yml";
const SHARD_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRepositoryPath(repoRoot, relativePath, kind) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\")
  ) {
    throw new Error(`${kind} must be a non-empty POSIX repository path`);
  }

  const absolutePath = path.resolve(repoRoot, relativePath);
  const relativeToRoot = path.relative(repoRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw new Error(`${kind} escapes the repository: ${relativePath}`);
  }
  return absolutePath;
}

export function validateLiveScenarioManifest(
  value,
  { repoRoot = REPO_ROOT, requirePaths = true } = {},
) {
  if (!isRecord(value)) {
    throw new Error("live scenario manifest must be a JSON object");
  }
  if (value.schema !== EXPECTED_SCHEMA) {
    throw new Error(`live scenario manifest schema must be ${EXPECTED_SCHEMA}`);
  }
  if (value.authority !== EXPECTED_AUTHORITY) {
    throw new Error(`live scenario authority must be ${EXPECTED_AUTHORITY}`);
  }
  if (!Array.isArray(value.shards) || value.shards.length === 0) {
    throw new Error("live scenario manifest must declare at least one shard");
  }

  const authorityPath = assertRepositoryPath(
    repoRoot,
    value.authority,
    "authority",
  );
  if (requirePaths && !statSync(authorityPath).isFile()) {
    throw new Error(
      `live scenario authority is not a file: ${value.authority}`,
    );
  }

  const names = new Set();
  const normalizedShards = value.shards.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`live scenario shard ${index} must be an object`);
    }
    const { name, root, globs } = candidate;
    if (typeof name !== "string" || !SHARD_NAME_PATTERN.test(name)) {
      throw new Error(`live scenario shard ${index} has an invalid name`);
    }
    if (names.has(name)) {
      throw new Error(`duplicate live scenario shard: ${name}`);
    }
    names.add(name);

    const rootPath = assertRepositoryPath(repoRoot, root, `root for ${name}`);
    if (requirePaths) {
      const canonicalRoot = realpathSync(rootPath);
      const canonicalRepo = realpathSync(repoRoot);
      const relativeCanonicalRoot = path.relative(canonicalRepo, canonicalRoot);
      if (
        relativeCanonicalRoot === ".." ||
        relativeCanonicalRoot.startsWith(`..${path.sep}`) ||
        !statSync(canonicalRoot).isDirectory()
      ) {
        throw new Error(`live scenario root is invalid: ${root}`);
      }
    }
    if (!Array.isArray(globs) || globs.length === 0) {
      throw new Error(`live scenario shard ${name} must declare file globs`);
    }

    const uniqueGlobs = new Set();
    for (const glob of globs) {
      assertRepositoryPath(repoRoot, glob, `glob for ${name}`);
      if (!glob.startsWith(`${root}/`)) {
        throw new Error(
          `live scenario glob must stay beneath ${root}: ${glob}`,
        );
      }
      if (!glob.endsWith(".scenario.ts")) {
        throw new Error(`live scenario glob must select .scenario.ts: ${glob}`);
      }
      if (uniqueGlobs.has(glob)) {
        throw new Error(
          `duplicate glob in live scenario shard ${name}: ${glob}`,
        );
      }
      uniqueGlobs.add(glob);
    }

    return { name, root, globs: [...uniqueGlobs] };
  });

  return {
    schema: EXPECTED_SCHEMA,
    authority: EXPECTED_AUTHORITY,
    shards: normalizedShards,
  };
}

export function loadLiveScenarioManifest(
  manifestPath = LIVE_SCENARIO_MANIFEST_PATH,
  options,
) {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  return validateLiveScenarioManifest(parsed, options);
}

export function selectLiveScenarioShards(manifest, selected = "all") {
  if (selected === "all") {
    return manifest.shards;
  }
  const shard = manifest.shards.find(
    (candidate) => candidate.name === selected,
  );
  if (!shard) {
    throw new Error(
      `unknown live scenario shard "${selected}"; expected all or one of ${manifest.shards
        .map((candidate) => candidate.name)
        .join(", ")}`,
    );
  }
  return [shard];
}

function parseArguments(argv) {
  const options = {
    manifestPath: LIVE_SCENARIO_MANIFEST_PATH,
    selected: "all",
    githubOutput: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") {
      const value = argv[index + 1];
      if (!value) throw new Error("--manifest requires a path");
      options.manifestPath = path.resolve(value);
      index += 1;
    } else if (argument === "--shard") {
      const value = argv[index + 1];
      if (!value) throw new Error("--shard requires a name");
      options.selected = value;
      index += 1;
    } else if (argument === "--github-output") {
      options.githubOutput = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = loadLiveScenarioManifest(options.manifestPath);
  const matrix = {
    shard: selectLiveScenarioShards(manifest, options.selected),
  };
  const serialized = JSON.stringify(matrix);
  if (options.githubOutput) {
    // GitHub injects this per-step file path; it is not a Turborepo task input.
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions protocol boundary.
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath) {
      throw new Error("GITHUB_OUTPUT is required with --github-output");
    }
    appendFileSync(outputPath, `matrix=${serialized}\n`, "utf8");
  } else {
    process.stdout.write(`${serialized}\n`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 CLI boundary translates validation failures into a nonzero process result.
    process.stderr.write(
      `[live-scenario-matrix] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

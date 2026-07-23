/**
 * Authoritative discovery for first-party dynamic-view build targets.
 *
 * A target exists only when a declared workspace owns one supported
 * `vite.config.views.*` file and exposes the matching `build:views` package
 * script. Build and validation commands share this inventory so neither can
 * silently omit a newly added, renamed, nested, or case-colliding target.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import { listPackages } from "./workspaces.mjs";

const VIEW_CONFIG_BASENAME =
  /^vite\.config\.views\.(?:ts|mts|cts|js|mjs|cjs)$/i;

function normalizeRelativePath(value) {
  return value.split("\\").join("/").replace(/^\.\//, "");
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizedIdentity(value) {
  return normalizeRelativePath(value).toLocaleLowerCase("en-US");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function listRepositoryFiles(repoRoot) {
  const output = execFileSync(
    "git",
    [
      "-C",
      repoRoot,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map(normalizeRelativePath)
    .sort(compareText);
}

function assertNoCaseCollisions(values, label) {
  const seen = new Map();
  for (const value of values) {
    const identity = normalizedIdentity(value);
    const previous = seen.get(identity);
    if (previous && previous !== value) {
      throw new Error(
        `[view-inventory] case-colliding ${label}: ${previous} and ${value}`,
      );
    }
    seen.set(identity, value);
  }
}

function assertUniqueTargetIdentities(targets) {
  const owners = new Map();
  for (const target of targets) {
    for (const identity of [
      target.name,
      target.packageName,
      target.workspaceDir,
    ]) {
      const normalized = normalizedIdentity(identity);
      const previous = owners.get(normalized);
      if (previous && previous !== target.workspaceDir) {
        throw new Error(
          `[view-inventory] target identity "${identity}" is shared by ${previous} and ${target.workspaceDir}`,
        );
      }
      owners.set(normalized, target.workspaceDir);
    }
  }
}

function configReferences(scriptBody) {
  const references = [];
  const pattern = /--config(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  for (const match of scriptBody.matchAll(pattern)) {
    references.push(normalizeRelativePath(match[1] ?? match[2] ?? match[3]));
  }
  return references;
}

function validateBuildScript(workspace, configName) {
  const script = workspace.packageJson.scripts?.["build:views"];
  if (typeof script !== "string" || script.trim().length === 0) {
    throw new Error(
      `[view-inventory] ${workspace.dir}/${configName} has no non-empty build:views package script`,
    );
  }

  const references = configReferences(script);
  if (references.length !== 1 || references[0] !== configName) {
    throw new Error(
      `[view-inventory] ${workspace.dir} build:views must reference exactly ${configName} via --config`,
    );
  }
  return script;
}

function validateViteDependency(workspace) {
  const declared =
    workspace.packageJson.devDependencies?.vite ??
    workspace.packageJson.dependencies?.vite;
  const minimum =
    typeof declared === "string" ? semver.minVersion(declared) : null;
  if (!minimum || minimum.major < 8) {
    throw new Error(
      `[view-inventory] ${workspace.dir} must declare Vite 8 or newer directly; the shared bundle config uses Rolldown output contracts`,
    );
  }
  return declared;
}

/**
 * Return the complete dynamic-view build inventory.
 *
 * Tests may inject `workspacePackages` and `repositoryFiles`; production calls
 * derive both from the root workspace declaration and Git's tracked/untracked
 * non-ignored file set.
 */
export function discoverViewBundleInventory(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const workspacePackages =
    options.workspacePackages ?? listPackages({ repoRoot });
  const repositoryFiles = (
    options.repositoryFiles ?? listRepositoryFiles(repoRoot)
  ).map(normalizeRelativePath);
  const configPaths = repositoryFiles.filter((relativePath) =>
    VIEW_CONFIG_BASENAME.test(path.posix.basename(relativePath)),
  );

  assertNoCaseCollisions(
    workspacePackages.map(({ dir }) => normalizeRelativePath(dir)),
    "workspace paths",
  );
  assertNoCaseCollisions(configPaths, "view configs");

  const workspaceByDir = new Map(
    workspacePackages.map((workspace) => [
      normalizeRelativePath(workspace.dir),
      workspace,
    ]),
  );
  const unownedConfigs = configPaths.filter(
    (configPath) =>
      !workspaceByDir.has(
        normalizeRelativePath(path.posix.dirname(configPath)),
      ),
  );
  if (unownedConfigs.length > 0) {
    throw new Error(
      `[view-inventory] view config(s) are outside declared workspaces: ${unownedConfigs.join(", ")}`,
    );
  }

  const targets = [];
  for (const workspace of workspacePackages) {
    const workspaceDir = normalizeRelativePath(workspace.dir);
    const absoluteDir = path.join(repoRoot, workspaceDir);
    const onDiskConfigNames = readdirSync(absoluteDir)
      .filter((name) => VIEW_CONFIG_BASENAME.test(name))
      .sort(compareText);
    const repositoryConfigNames = configPaths
      .filter(
        (configPath) =>
          normalizeRelativePath(path.posix.dirname(configPath)) ===
          workspaceDir,
      )
      .map((configPath) => path.posix.basename(configPath))
      .sort(compareText);

    if (
      JSON.stringify(onDiskConfigNames) !==
      JSON.stringify(repositoryConfigNames)
    ) {
      throw new Error(
        `[view-inventory] ${workspaceDir} view configs differ between Git discovery (${repositoryConfigNames.join(", ") || "none"}) and the filesystem (${onDiskConfigNames.join(", ") || "none"})`,
      );
    }
    if (onDiskConfigNames.length > 1) {
      throw new Error(
        `[view-inventory] ${workspaceDir} owns multiple view configs: ${onDiskConfigNames.join(", ")}`,
      );
    }

    const buildScript = workspace.packageJson.scripts?.["build:views"];
    if (onDiskConfigNames.length === 0) {
      if (buildScript !== undefined) {
        throw new Error(
          `[view-inventory] ${workspaceDir} declares build:views without a supported vite.config.views.* file`,
        );
      }
      continue;
    }

    const configName = onDiskConfigNames[0];
    const configAbsolute = path.join(absoluteDir, configName);
    const configMetadata = lstatSync(configAbsolute);
    if (!configMetadata.isFile() || configMetadata.isSymbolicLink()) {
      throw new Error(
        `[view-inventory] ${workspaceDir}/${configName} must be a regular file`,
      );
    }
    const configContent = readFileSync(configAbsolute);
    const validatedBuildScript = validateBuildScript(workspace, configName);
    const viteDependency = validateViteDependency(workspace);
    const packageName = workspace.packageJson.name;
    if (typeof packageName !== "string" || packageName.length === 0) {
      throw new Error(
        `[view-inventory] ${workspaceDir} must declare a package name`,
      );
    }
    const directoryName = path.posix.basename(workspaceDir);
    targets.push({
      name: directoryName,
      packageName,
      workspaceDir,
      config: `${workspaceDir}/${configName}`,
      configAbsolute,
      configBytes: configContent.byteLength,
      configSha256: sha256(configContent),
      packageManifestSha256: sha256(JSON.stringify(workspace.packageJson)),
      bundle: `${workspaceDir}/dist/views/bundle.js`,
      bundleAbsolute: path.join(absoluteDir, "dist", "views", "bundle.js"),
      buildScript: validatedBuildScript,
      viteDependency,
    });
  }

  assertUniqueTargetIdentities(targets);
  if (targets.length === 0) {
    throw new Error(
      "[view-inventory] discovered zero configured view-build targets",
    );
  }

  return {
    targets: targets.sort((left, right) =>
      compareText(left.workspaceDir, right.workspaceDir),
    ),
    workspaceCount: workspacePackages.length,
    configCount: configPaths.length,
    exclusions: [],
  };
}

/** Strip local absolute paths while preserving the complete evidence inventory. */
export function serializeViewBundleInventory(inventory) {
  const serialized = {
    schemaVersion: 2,
    workspaceCount: inventory.workspaceCount,
    configCount: inventory.configCount,
    discoveredCount: inventory.targets.length,
    excludedCount: inventory.exclusions.length,
    targets: inventory.targets.map(
      ({
        name,
        packageName,
        workspaceDir,
        config,
        configBytes,
        configSha256,
        bundle,
        buildScript,
        packageManifestSha256,
        viteDependency,
      }) => ({
        name,
        packageName,
        workspaceDir,
        config,
        configBytes,
        configSha256,
        bundle,
        buildScript,
        packageManifestSha256,
        viteDependency,
      }),
    ),
    exclusions: inventory.exclusions,
  };
  return {
    ...serialized,
    inventorySha256: sha256(JSON.stringify(serialized)),
  };
}

/** Resolve a CLI filter to one unambiguous target, or return every target. */
export function selectViewBundleTargets(targets, filter) {
  if (filter === undefined) return targets;
  const requested = normalizedIdentity(filter);
  const exact = targets.filter(({ name, packageName, workspaceDir }) =>
    [name, packageName, workspaceDir].some(
      (identity) => normalizedIdentity(identity) === requested,
    ),
  );
  if (exact.length === 1) return exact;
  if (exact.length > 1) {
    throw new Error(
      `[view-inventory] filter "${filter}" matches multiple exact targets`,
    );
  }

  const partial = targets.filter(({ name, packageName, workspaceDir }) =>
    [name, packageName, workspaceDir].some((identity) =>
      normalizedIdentity(identity).includes(requested),
    ),
  );
  if (partial.length === 1) return partial;
  if (partial.length === 0) {
    throw new Error(`[view-inventory] filter "${filter}" matched no target`);
  }
  throw new Error(
    `[view-inventory] filter "${filter}" is ambiguous: ${partial
      .map(({ workspaceDir }) => workspaceDir)
      .join(", ")}`,
  );
}

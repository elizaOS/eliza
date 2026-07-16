/**
 * Applies release-only package manifest rewrites as validated transactions.
 * Workspace reference changes carry a byte-exact journal for restoration, and
 * every discovery, parse, target-resolution, staging, write, or rollback error
 * surfaces instead of allowing a partially healthy-looking release tree.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { sha512Integrity, stableStringify } from "./release-contract.mjs";
import { listPackages } from "./workspaces.mjs";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export const WORKSPACE_REF_JOURNAL_SCHEMA_VERSION = 1;

function parseJsonSource(filePath, source) {
  try {
    return JSON.parse(source);
  } catch (error) {
    // error-policy:J2 identify the intended manifest that invalidated the rewrite
    throw new Error(`Invalid JSON in ${filePath}`, { cause: error });
  }
}

function readJsonFile(filePath) {
  return parseJsonSource(filePath, readFileSync(filePath, "utf8"));
}

function detectIndent(source) {
  const match = source.match(/^([ \t]+)"/m);
  if (!match) return 2;
  return match[1].includes("\t") ? "\t" : match[1].length;
}

function serializeLike(source, value) {
  return `${JSON.stringify(value, null, detectIndent(source))}\n`;
}

function assertInsideRepo(repoRoot, filePath) {
  const relativePath = path.relative(repoRoot, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Manifest path escapes repository root: ${filePath}`);
  }
  return relativePath.split(path.sep).join("/");
}

/** Apply fully computed manifest sources, rolling back every completed write. */
export function applyManifestTransaction(updates) {
  const changed = updates.filter(
    ({ originalSource, nextSource }) => originalSource !== nextSource,
  );
  const staged = [];
  const committed = [];
  try {
    for (const [index, update] of changed.entries()) {
      const temporaryPath = `${update.filePath}.release-${process.pid}-${index}.tmp`;
      writeFileSync(temporaryPath, update.nextSource, {
        encoding: "utf8",
        flag: "wx",
      });
      staged.push({ temporaryPath, update });
    }
    for (const entry of staged) {
      renameSync(entry.temporaryPath, entry.update.filePath);
      committed.push(entry.update);
    }
  } catch (error) {
    // error-policy:J1 manifest mutation boundary restores every completed write
    const rollbackErrors = [];
    for (const update of committed.reverse()) {
      try {
        writeFileSync(update.filePath, update.originalSource, "utf8");
      } catch (rollbackError) {
        // error-policy:J6 rollback is attempted for every already-written manifest
        rollbackErrors.push(rollbackError);
      }
    }
    for (const { temporaryPath } of staged) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        // error-policy:J6 staged temp cleanup cannot replace the rewrite failure
        rollbackErrors.push(cleanupError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Manifest transaction and rollback failed",
      );
    }
    throw error;
  }
  return changed.length;
}

function loadLernaPatterns(repoRoot) {
  const lernaPath = path.join(repoRoot, "lerna.json");
  const lerna = readJsonFile(lernaPath);
  if (
    !Array.isArray(lerna.packages) ||
    lerna.packages.some((pattern) => typeof pattern !== "string")
  ) {
    throw new Error(`${lernaPath} must declare a packages string array`);
  }
  return lerna.packages;
}

function releaseManagedPackages(repoRoot) {
  return listPackages({ repoRoot, patterns: loadLernaPatterns(repoRoot) });
}

function fullWorkspaceByName(repoRoot) {
  const byName = new Map();
  for (const workspacePackage of listPackages({ repoRoot })) {
    if (
      typeof workspacePackage.name === "string" &&
      workspacePackage.name.length > 0
    ) {
      byName.set(workspacePackage.name, workspacePackage);
    }
  }
  return byName;
}

export function computeWorkspaceReferenceUpdates(repoRoot) {
  const root = path.resolve(repoRoot);
  const workspaceByName = fullWorkspaceByName(root);
  const updates = [];
  const journalRecords = [];
  for (const workspacePackage of releaseManagedPackages(root)) {
    const filePath = path.join(root, workspacePackage.dir, "package.json");
    const originalSource = readFileSync(filePath, "utf8");
    const manifest = parseJsonSource(filePath, originalSource);
    const changes = [];
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = manifest[section];
      if (dependencies === undefined) continue;
      if (
        !dependencies ||
        typeof dependencies !== "object" ||
        Array.isArray(dependencies)
      ) {
        throw new Error(
          `${workspacePackage.name} ${section} must be an object`,
        );
      }
      for (const [dependencyName, range] of Object.entries(dependencies)) {
        if (typeof range !== "string" || !range.startsWith("workspace:"))
          continue;
        const target = workspaceByName.get(dependencyName);
        if (!target) {
          throw new Error(
            `${workspacePackage.name} ${section}.${dependencyName} uses ${range}, but the target is not a workspace`,
          );
        }
        const targetVersion = target.packageJson.version;
        if (typeof targetVersion !== "string" || targetVersion.length === 0) {
          throw new Error(
            `${dependencyName} is missing a version required by ${workspacePackage.name}`,
          );
        }
        dependencies[dependencyName] = targetVersion;
        changes.push({
          section,
          dependencyName,
          from: range,
          to: targetVersion,
        });
      }
    }
    const nextSource =
      changes.length > 0
        ? serializeLike(originalSource, manifest)
        : originalSource;
    updates.push({ filePath, originalSource, nextSource });
    if (changes.length > 0) {
      journalRecords.push({
        path: assertInsideRepo(root, filePath),
        originalSource,
        originalIntegrity: sha512Integrity(originalSource),
        updatedIntegrity: sha512Integrity(nextSource),
        changes,
      });
    }
  }
  return { updates, journalRecords };
}

export function replaceWorkspaceReferences({
  repoRoot,
  journalPath,
  dryRun = false,
}) {
  const root = path.resolve(repoRoot);
  const journal = path.resolve(journalPath);
  if (existsSync(journal))
    throw new Error(`Workspace reference journal already exists: ${journal}`);
  const { updates, journalRecords } = computeWorkspaceReferenceUpdates(root);
  if (dryRun) return { changedFiles: journalRecords.length, journalRecords };
  const changedFiles = applyManifestTransaction(updates);
  const journalDocument = {
    schemaVersion: WORKSPACE_REF_JOURNAL_SCHEMA_VERSION,
    records: journalRecords,
  };
  try {
    mkdirSync(path.dirname(journal), { recursive: true });
    writeFileSync(journal, stableStringify(journalDocument), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    // error-policy:J1 journal boundary restores rewrites before surfacing failure
    const restoreUpdates = journalRecords.map((record) => {
      const filePath = path.join(root, record.path);
      return {
        filePath,
        originalSource: readFileSync(filePath, "utf8"),
        nextSource: record.originalSource,
      };
    });
    try {
      applyManifestTransaction(restoreUpdates);
    } catch (rollbackError) {
      // error-policy:J2 losing the journal after rewrites requires both failures
      throw new AggregateError(
        [error, rollbackError],
        "Journal write and manifest rollback failed",
      );
    }
    throw error;
  }
  return { changedFiles, journalRecords };
}

export function restoreWorkspaceReferences({
  repoRoot,
  journalPath,
  dryRun = false,
}) {
  const root = path.resolve(repoRoot);
  const journal = path.resolve(journalPath);
  const document = readJsonFile(journal);
  if (
    document?.schemaVersion !== WORKSPACE_REF_JOURNAL_SCHEMA_VERSION ||
    !Array.isArray(document.records)
  ) {
    throw new Error(`Malformed workspace reference journal ${journal}`);
  }
  const updates = document.records.map((record, index) => {
    if (
      typeof record?.path !== "string" ||
      typeof record.originalSource !== "string" ||
      typeof record.originalIntegrity !== "string" ||
      typeof record.updatedIntegrity !== "string"
    ) {
      throw new Error(`Malformed workspace reference journal record ${index}`);
    }
    const filePath = path.resolve(root, record.path);
    assertInsideRepo(root, filePath);
    const currentSource = readFileSync(filePath, "utf8");
    if (sha512Integrity(currentSource) !== record.updatedIntegrity) {
      throw new Error(
        `${record.path} changed after workspace replacement; refusing a destructive restore`,
      );
    }
    if (sha512Integrity(record.originalSource) !== record.originalIntegrity) {
      throw new Error(
        `${record.path} journal original source has invalid integrity`,
      );
    }
    return {
      filePath,
      originalSource: currentSource,
      nextSource: record.originalSource,
    };
  });
  if (dryRun) return { changedFiles: updates.length };
  const changedFiles = applyManifestTransaction(updates);
  unlinkSync(journal);
  return { changedFiles };
}

export function setPublicAccess({ repoRoot, packageNames, dryRun = false }) {
  const root = path.resolve(repoRoot);
  const requested = packageNames ? new Set(packageNames) : null;
  const packages = listPackages({ repoRoot: root });
  if (requested) {
    const found = new Set(packages.map(({ name }) => name).filter(Boolean));
    const missing = [...requested].filter((name) => !found.has(name));
    if (missing.length > 0)
      throw new Error(`Unknown access-rewrite packages: ${missing.join(", ")}`);
  }
  const updates = [];
  let changedFiles = 0;
  for (const workspacePackage of packages) {
    if (
      typeof workspacePackage.name !== "string" ||
      !workspacePackage.name.startsWith("@elizaos/") ||
      workspacePackage.packageJson.private === true ||
      (requested && !requested.has(workspacePackage.name))
    ) {
      continue;
    }
    const filePath = path.join(root, workspacePackage.dir, "package.json");
    const originalSource = readFileSync(filePath, "utf8");
    const manifest = parseJsonSource(filePath, originalSource);
    if (
      manifest.publishConfig !== undefined &&
      (!manifest.publishConfig ||
        typeof manifest.publishConfig !== "object" ||
        Array.isArray(manifest.publishConfig))
    ) {
      throw new Error(
        `${workspacePackage.name} publishConfig must be an object`,
      );
    }
    if (manifest.publishConfig?.access === "public") {
      updates.push({ filePath, originalSource, nextSource: originalSource });
      continue;
    }
    const publishConfig =
      manifest.publishConfig === undefined ? {} : manifest.publishConfig;
    manifest.publishConfig = { ...publishConfig, access: "public" };
    updates.push({
      filePath,
      originalSource,
      nextSource: serializeLike(originalSource, manifest),
    });
    changedFiles += 1;
  }
  if (!dryRun) applyManifestTransaction(updates);
  return { changedFiles };
}

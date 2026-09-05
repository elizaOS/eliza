#!/usr/bin/env node
/**
 * Runs the repository Knip audit as deterministic, graph-aware, memory-bounded shards.
 *
 * Each authoritative workspace remains one logical owner partition. Small
 * batches of its workspace dependents are analyzed from the repository root so
 * cross-workspace use stays visible; only findings present in every successful
 * dependent shard survive into the owner's inventory.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteFileSync,
  resolveReportArtifactPath,
} from "./lib/report-artifact-path.mjs";
import { listPackages } from "./lib/workspaces.mjs";

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const knipRequire = createRequire(require.resolve("knip"));
const picomatch = knipRequire("picomatch");
const OLD_SPACE_CEILING_MIB = 4096;
const DEPENDENT_BATCH_SIZE = 16;
const DEPENDENT_SOURCE_FILE_LIMIT = 1600;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const ISSUE_TYPES = [
  "binaries",
  "catalog",
  "catalogReferences",
  "cycles",
  "dependencies",
  "devDependencies",
  "duplicates",
  "enumMembers",
  "exports",
  "files",
  "namespaceMembers",
  "nsExports",
  "nsTypes",
  "optionalPeerDependencies",
  "types",
  "unlisted",
  "unresolved",
];
const ISSUE_TYPE_SET = new Set(ISSUE_TYPES);
// These findings mean "unused by the analyzed graph". A consumer in any shard
// disproves them, so only findings present in every dependent context survive.
// The remaining types describe positive observations (for example a cycle,
// unresolved import, or manifest dependency issue) and are unioned instead.
const CONSUMER_SENSITIVE_ISSUE_TYPES = new Set([
  "enumMembers",
  "exports",
  "files",
  "namespaceMembers",
  "nsExports",
  "nsTypes",
  "types",
]);
const STRUCTURAL_REPORT_KEYS = new Set(["file", "owners"]);
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const SOURCE_SCAN_SKIP_DIRS = new Set([
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "storybook-static",
  "vendor",
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(file, label) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    // error-policy:J2 name the required audit input that could not be read
    throw new Error(`Cannot read ${label}: ${file}`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    // error-policy:J2 malformed configuration must fail the audit
    throw new Error(`Invalid JSON in ${label}: ${file}`, { cause: error });
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function artifact(repoRoot, relative, extension, label) {
  return resolveReportArtifactPath(repoRoot, relative, {
    extension,
    label,
  }).absolute;
}

function atomicWrite(repoRoot, relative, value) {
  const file = artifact(repoRoot, relative, ".json", "Knip report artifact");
  mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, value);
  return file;
}

function acquireReportLock(repoRoot, reportsDir) {
  const lockFile = artifact(
    repoRoot,
    `${reportsDir}/run.lock`,
    ".lock",
    "Knip report lock",
  );
  mkdirSync(path.dirname(lockFile), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(
      lockFile,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    // error-policy:J2 concurrent publishers must not interleave canonical evidence
    throw new Error(`Knip report publication is already locked: ${lockFile}`, {
      cause: error,
    });
  }
  return () => {
    // error-policy:J6 lock cleanup is teardown after all canonical writes finish
    closeSync(descriptor);
    rmSync(lockFile, { force: true });
  };
}

function arrayKey(value) {
  return JSON.stringify(canonicalize(value));
}

function mergeKnipConfig(...configs) {
  const merge = (left, right) => {
    if (Array.isArray(left) && Array.isArray(right)) {
      const seen = new Set();
      return [...left, ...right].filter((item) => {
        const key = arrayKey(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (
      left &&
      right &&
      typeof left === "object" &&
      typeof right === "object" &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const result = { ...left };
      for (const [key, value] of Object.entries(right)) {
        result[key] = key in result ? merge(result[key], value) : value;
      }
      return result;
    }
    return right;
  };
  return configs.reduce((result, config) => merge(result, config), {});
}

function normalizeWorkspace(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new Error(`Invalid root Knip workspace key: ${String(value)}`);
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Invalid root Knip workspace key: ${value}`);
  }
  return normalized.replace(/\/$/, "");
}

function discoverPackages(repoRoot, rootConfig) {
  const packages = listPackages({ repoRoot }).map((workspacePackage) => ({
    ...workspacePackage,
    source: "root-workspaces",
  }));
  const byDir = new Map(packages.map((item) => [item.dir, item]));
  const configured = new Set();
  for (const rawDir of Object.keys(rootConfig.workspaces ?? {})) {
    const dir = normalizeWorkspace(rawDir);
    if (configured.has(dir)) {
      throw new Error(`Duplicate root Knip workspace identity: ${dir}`);
    }
    configured.add(dir);
    if (byDir.has(dir)) continue;
    const manifestFile = path.join(repoRoot, dir, "package.json");
    if (!existsSync(manifestFile)) continue;
    const packageJson = readJson(manifestFile, `${dir} package manifest`);
    const item = {
      name: packageJson.name,
      dir,
      packageJson,
      source: "root-knip-workspace",
    };
    packages.push(item);
    byDir.set(dir, item);
  }
  packages.sort((left, right) => compareText(left.dir, right.dir));
  const names = new Map();
  const slugs = new Set();
  for (const item of packages) {
    if (typeof item.name === "string" && item.name.length > 0) {
      const previous = names.get(item.name);
      if (previous) {
        throw new Error(
          `Duplicate workspace package name ${item.name}: ${previous} and ${item.dir}`,
        );
      }
      names.set(item.name, item.dir);
    }
    const slug = item.dir.replaceAll("/", "--");
    if (slugs.has(slug)) {
      throw new Error(`Colliding Knip partition report name: ${slug}`);
    }
    slugs.add(slug);
  }
  return { packages, names };
}

function declaredTypecheckTsConfig(repoRoot, item) {
  const typecheck = item.packageJson.scripts?.typecheck;
  if (typeof typecheck !== "string") return undefined;
  const match = typecheck.match(/(?:^|\s)(?:-p|--project)\s+([^\s]+)/);
  if (!match) return undefined;
  const relative = path.posix.normalize(match[1].replaceAll("\\", "/"));
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative)
  ) {
    throw new Error(`Unsafe typecheck tsconfig for ${item.dir}: ${match[1]}`);
  }
  const absolute = path.join(repoRoot, item.dir, relative);
  if (!existsSync(absolute)) {
    throw new Error(`Missing typecheck tsconfig for ${item.dir}: ${relative}`);
  }
  return path.posix.join(item.dir, relative);
}

function sourceFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => compareText(left.name, right.name),
    )) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name.startsWith(".") ||
          SOURCE_SCAN_SKIP_DIRS.has(entry.name)
        ) {
          continue;
        }
        pending.push(absolute);
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(absolute);
      }
    }
  }
  return files.sort(compareText);
}

function containingWorkspace(absolute, workspaceRoots) {
  return workspaceRoots.find(
    ({ root }) =>
      absolute === root || absolute.startsWith(`${root}${path.sep}`),
  )?.dir;
}

function isPublicSubpath(exportsField, subpath) {
  if (
    !exportsField ||
    typeof exportsField !== "object" ||
    Array.isArray(exportsField)
  ) {
    return false;
  }
  for (const key of Object.keys(exportsField)) {
    if (!key.startsWith(".")) continue;
    const pattern = key
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*");
    if (new RegExp(`^${pattern}$`).test(subpath)) return true;
  }
  return false;
}

function arrayify(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function createEntryMatchers(repoRoot, discovery, rootConfig) {
  const matchers = new Map();
  for (const item of discovery.packages) {
    const localFile = path.join(repoRoot, item.dir, "knip.json");
    const local = existsSync(localFile)
      ? readJson(localFile, `${item.dir} Knip configuration`)
      : {};
    const configured = mergeKnipConfig(
      arrayify(rootConfig.workspaces?.[item.dir]?.entry),
      arrayify(local.entry),
    );
    const patterns =
      configured.length > 0 ? configured : arrayify(rootConfig.entry);
    const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
    const negative = patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1));
    const isPositive = positive.length > 0 ? picomatch(positive) : () => false;
    const isNegative = negative.length > 0 ? picomatch(negative) : () => false;
    const root = path.join(repoRoot, item.dir);
    matchers.set(item.dir, (absolute) => {
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      return (
        !relative.startsWith("../") &&
        isPositive(relative) &&
        !isNegative(relative)
      );
    });
  }
  return matchers;
}

function resolveRelativeImport(importer, specifier) {
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const unresolvedExtension = path.extname(unresolved);
  const sourceSiblingBase = [".js", ".jsx", ".mjs", ".cjs"].includes(
    unresolvedExtension,
  )
    ? path.join(
        path.dirname(unresolved),
        path.basename(unresolved, unresolvedExtension),
      )
    : undefined;
  const candidates = [
    unresolved,
    ...[...SOURCE_EXTENSIONS].map((extension) => `${unresolved}${extension}`),
    ...(sourceSiblingBase
      ? [".ts", ".tsx", ".mts", ".cts"].map(
          (extension) => `${sourceSiblingBase}${extension}`,
        )
      : []),
    ...[...SOURCE_EXTENSIONS].map((extension) =>
      path.join(unresolved, `index${extension}`),
    ),
  ];
  return (
    candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    ) ?? unresolved
  );
}

function importedWorkspace(
  specifier,
  importer,
  packageNames,
  workspaceRoots,
  entryMatchers,
) {
  if (specifier.startsWith(".")) {
    const imported = resolveRelativeImport(importer, specifier);
    const workspace = containingWorkspace(imported, workspaceRoots);
    return {
      workspace,
      needsContext: workspace ? !entryMatchers.get(workspace)(imported) : false,
    };
  }
  for (const [name, item] of packageNames) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      const subpath = `./${specifier.slice(name.length + 1)}`;
      return {
        workspace: item.dir,
        needsContext:
          specifier !== name &&
          !isPublicSubpath(item.packageJson.exports, subpath),
      };
    }
  }
  return { workspace: undefined, needsContext: false };
}

function buildWorkspaceGraph(repoRoot, discovery, rootConfig) {
  const dependencies = new Map(
    discovery.packages.map(({ dir }) => [dir, new Set()]),
  );
  const dependents = new Map(
    discovery.packages.map(({ dir }) => [dir, new Set()]),
  );
  const manifestDependents = new Map(
    discovery.packages.map(({ dir }) => [dir, new Set()]),
  );
  const sourceDependents = new Map(
    discovery.packages.map(({ dir }) => [dir, new Set()]),
  );
  const contextDependents = new Map(
    discovery.packages.map(({ dir }) => [dir, new Set()]),
  );
  const sourceFileCounts = new Map(
    discovery.packages.map(({ dir }) => [dir, 0]),
  );
  const addEdge = (consumer, provider, provenance, needsContext = false) => {
    if (!provider || provider === consumer) return;
    dependencies.get(consumer).add(provider);
    dependents.get(provider).add(consumer);
    provenance.get(provider).add(consumer);
    if (needsContext) contextDependents.get(provider).add(consumer);
  };
  for (const item of discovery.packages) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(item.packageJson[field] ?? {})) {
        const dependency = discovery.names.get(name);
        addEdge(item.dir, dependency, manifestDependents);
      }
    }
  }
  const workspaceRoots = discovery.packages
    .map(({ dir }) => ({ dir, root: path.join(repoRoot, dir) }))
    .sort(
      (left, right) =>
        right.root.length - left.root.length ||
        compareText(left.root, right.root),
    );
  const packageNames = discovery.packages
    .filter(({ name }) => typeof name === "string" && name.length > 0)
    .map((item) => [item.name, item])
    .sort(
      ([left], [right]) =>
        right.length - left.length || compareText(left, right),
    );
  const entryMatchers = createEntryMatchers(repoRoot, discovery, rootConfig);
  for (const item of discovery.packages) {
    for (const file of sourceFiles(path.join(repoRoot, item.dir))) {
      if (containingWorkspace(file, workspaceRoots) !== item.dir) continue;
      sourceFileCounts.set(item.dir, sourceFileCounts.get(item.dir) + 1);
      const source = readFileSync(file, "utf8");
      for (const imported of ts.preProcessFile(source, true, true)
        .importedFiles) {
        const edge = importedWorkspace(
          imported.fileName,
          file,
          packageNames,
          workspaceRoots,
          entryMatchers,
        );
        addEdge(item.dir, edge.workspace, sourceDependents, edge.needsContext);
      }
    }
  }
  return {
    dependencies,
    dependents,
    manifestDependents,
    sourceDependents,
    contextDependents,
    sourceFileCounts,
  };
}

function batches(values, size, weights, weightLimit) {
  if (values.length === 0) return [[]];
  const result = [];
  let batch = [];
  let weight = 0;
  for (const value of values) {
    const valueWeight = weights.get(value) ?? 0;
    if (
      batch.length > 0 &&
      (batch.length >= size || weight + valueWeight > weightLimit)
    ) {
      result.push(batch);
      batch = [];
      weight = 0;
    }
    batch.push(value);
    weight += valueWeight;
  }
  if (batch.length > 0) result.push(batch);
  return result;
}

function buildTargetLedger(repoRoot, rootConfig) {
  rootConfig ??= readJson(
    path.join(repoRoot, "knip.json"),
    "root Knip configuration",
  );
  const discovery = discoverPackages(repoRoot, rootConfig);
  const graph = buildWorkspaceGraph(repoRoot, discovery, rootConfig);
  return discovery.packages.map((item, index) => {
    const containingOwner = discovery.packages
      .filter(({ dir }) => dir !== item.dir && item.dir.startsWith(`${dir}/`))
      .sort((left, right) => right.dir.length - left.dir.length)[0]?.dir;
    const directDependents = [...graph.contextDependents.get(item.dir)].sort(
      compareText,
    );
    const manifestDependents = [...graph.manifestDependents.get(item.dir)].sort(
      compareText,
    );
    const sourceDependents = [...graph.sourceDependents.get(item.dir)].sort(
      compareText,
    );
    const shards = batches(
      directDependents,
      DEPENDENT_BATCH_SIZE,
      graph.sourceFileCounts,
      DEPENDENT_SOURCE_FILE_LIMIT,
    ).map((dependentBatch, shardIndex) => {
      const allowed = new Set([item.dir, ...dependentBatch]);
      return {
        shardIndex,
        dependentBatch,
        dependentSourceFileCount: dependentBatch.reduce(
          (total, workspace) =>
            total + (graph.sourceFileCounts.get(workspace) ?? 0),
          0,
        ),
        allowedWorkspaces: [...allowed].sort(compareText),
      };
    });
    if (
      containingOwner &&
      shards.some(({ dependentBatch }) => dependentBatch.length > 0)
    ) {
      throw new Error(
        `Nested workspace ${item.dir} requires cross-workspace context and cannot be isolated from ${containingOwner}`,
      );
    }
    return {
      index,
      workspace: item.dir,
      source: item.source,
      sourceFileCount: graph.sourceFileCounts.get(item.dir),
      isolatedDirectory: containingOwner ? item.dir : undefined,
      tsConfig: declaredTypecheckTsConfig(repoRoot, item),
      directDependents,
      manifestDependents,
      sourceDependents,
      shards,
    };
  });
}

function standaloneKnipConfig(config, workspace) {
  const {
    ignoreWorkspaces: _ignoreWorkspaces,
    workspaces = {},
    ...globals
  } = config;
  return mergeKnipConfig(globals, workspaces[workspace] ?? {});
}

function effectiveRootConfig(repoRoot, rootConfig, allowed, allDirs) {
  const {
    ignoreWorkspaces: originalIgnored = [],
    workspaces = {},
    ...globals
  } = rootConfig;
  const mergedWorkspaces = {};
  for (const workspace of allowed) {
    const localFile = path.join(repoRoot, workspace, "knip.json");
    const localConfig = existsSync(localFile)
      ? readJson(localFile, `${workspace} Knip configuration`)
      : {};
    const {
      $schema: _schema,
      ignoreWorkspaces: _localIgnoredWorkspaces,
      workspaces: _localWorkspaces,
      ...local
    } = localConfig;
    mergedWorkspaces[workspace] = mergeKnipConfig(
      workspaces[workspace] ?? {},
      local,
    );
  }
  const unrelated = allDirs.filter((workspace) => !allowed.has(workspace));
  return {
    ...globals,
    ignoreWorkspaces: mergeKnipConfig(originalIgnored, unrelated),
    workspaces: mergedWorkspaces,
  };
}

function ownerForFile(file, workspaceDirs) {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return (
    workspaceDirs
      .filter(
        (workspace) =>
          normalized === workspace || normalized.startsWith(`${workspace}/`),
      )
      .sort(
        (left, right) => right.length - left.length || compareText(left, right),
      )[0] ?? null
  );
}

function validateKnipReport(source, workspace) {
  if (source.trim().length === 0) {
    throw new Error(`Missing Knip JSON output for ${workspace}`);
  }
  let report;
  try {
    report = JSON.parse(source);
  } catch (error) {
    // error-policy:J2 identify the shard that emitted malformed evidence
    throw new Error(`Malformed Knip JSON output for ${workspace}`, {
      cause: error,
    });
  }
  if (!report || !Array.isArray(report.issues)) {
    throw new Error(`Malformed Knip report shape for ${workspace}`);
  }
  for (const issue of report.issues) {
    if (!issue || typeof issue.file !== "string") {
      throw new Error(`Malformed Knip issue entry for ${workspace}`);
    }
    for (const key of Object.keys(issue)) {
      if (!STRUCTURAL_REPORT_KEYS.has(key) && !ISSUE_TYPE_SET.has(key)) {
        throw new Error(`Unknown Knip issue type ${key} for ${workspace}`);
      }
      if (key !== "file" && !Array.isArray(issue[key])) {
        throw new Error(`Malformed ${key} findings for ${workspace}`);
      }
    }
  }
  return report;
}

function findingInventory(workspace, report, workspaceDirs, isolatedDirectory) {
  const findings = [];
  for (const issue of report.issues) {
    const file = isolatedDirectory
      ? path.posix.join(workspace, issue.file.replaceAll("\\", "/"))
      : issue.file;
    if (ownerForFile(file, workspaceDirs) !== workspace) continue;
    for (const type of ISSUE_TYPES) {
      for (const finding of issue[type] ?? []) {
        findings.push({ workspace, file, type, finding });
      }
    }
  }
  return findings.sort((left, right) =>
    compareText(stableJson(left), stableJson(right)),
  );
}

function aggregateShardFindings(shards) {
  if (shards.length === 0) return [];
  const maps = shards.map(
    (findings) =>
      new Map(findings.map((finding) => [stableJson(finding), finding])),
  );
  const union = new Map(maps.flatMap((map) => [...map]));
  return [...union]
    .filter(
      ([key, finding]) =>
        !CONSUMER_SENSITIVE_ISSUE_TYPES.has(finding.type) ||
        maps.every((map) => map.has(key)),
    )
    .map(([, finding]) => finding)
    .sort((left, right) => compareText(stableJson(left), stableJson(right)));
}

function parseArgs(args) {
  const options = {
    repoRoot: DEFAULT_REPO_ROOT,
    strict: false,
    reportsDir: "reports/knip",
    knipBin: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (["--repo-root", "--reports-dir", "--knip-bin"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a path`);
      const key = {
        "--repo-root": "repoRoot",
        "--reports-dir": "reportsDir",
        "--knip-bin": "knipBin",
      }[arg];
      options[key] = key === "reportsDir" ? value : path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  options.repoRoot = path.resolve(options.repoRoot);
  options.knipBin ??= path.join(
    options.repoRoot,
    "node_modules/knip/bin/knip.js",
  );
  return options;
}

function infrastructureFailure(result, workspace) {
  if (result.error) return `could not start: ${result.error.message}`;
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    /heap out of memory|allocation failed|ineffective mark-compacts/i.test(
      combined,
    )
  ) {
    return "out of memory";
  }
  if (result.signal) return `terminated by ${result.signal}`;
  if (result.status !== 0) return `exited ${result.status}`;
  try {
    validateKnipReport(result.stdout, workspace);
  } catch (error) {
    return error.message;
  }
  return null;
}

function runLocked(options) {
  const runRelative = `${options.reportsDir}/run.json`;
  const aggregateRelative = `${options.reportsDir}/aggregate.json`;
  const aggregateFile = artifact(
    options.repoRoot,
    aggregateRelative,
    ".json",
    "Knip aggregate report",
  );
  rmSync(aggregateFile, { force: true });
  atomicWrite(
    options.repoRoot,
    runRelative,
    stableJson({
      schemaVersion: 2,
      mode: options.strict ? "strict" : "advisory",
      status: "incomplete",
      complete: false,
      reason: "partition reconciliation has not completed",
    }),
  );
  const rootConfig = readJson(
    path.join(options.repoRoot, "knip.json"),
    "root Knip configuration",
  );
  const ledger = buildTargetLedger(options.repoRoot, rootConfig);
  const workspaceDirs = ledger.map(({ workspace }) => workspace);
  const workspaceReportDir = path.dirname(
    artifact(
      options.repoRoot,
      `${options.reportsDir}/workspaces/sentinel.json`,
      ".json",
      "Knip workspace report",
    ),
  );
  const configDir = path.dirname(
    artifact(
      options.repoRoot,
      `${options.reportsDir}/configs/sentinel.json`,
      ".json",
      "Knip generated configuration",
    ),
  );
  rmSync(workspaceReportDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(workspaceReportDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  const executions = [];
  const aggregateFindings = [];
  for (const target of ledger) {
    const shardExecutions = [];
    const successfulShardFindings = [];
    for (const shard of target.shards) {
      const started = process.hrtime.bigint();
      const allowed = new Set(shard.allowedWorkspaces);
      const rootScopedConfig = effectiveRootConfig(
        options.repoRoot,
        rootConfig,
        allowed,
        workspaceDirs,
      );
      const config = target.isolatedDirectory
        ? standaloneKnipConfig(rootScopedConfig, target.workspace)
        : rootScopedConfig;
      const configSource = stableJson(config);
      const configDigest = createHash("sha256")
        .update(configSource)
        .digest("hex");
      const slug = target.workspace.replaceAll("/", "--");
      const shardLabel = `shard-${String(shard.shardIndex).padStart(3, "0")}`;
      const configFile = atomicWrite(
        options.repoRoot,
        `${options.reportsDir}/configs/${slug}--${shardLabel}.json`,
        configSource,
      );
      const workspaceArgs = target.isolatedDirectory
        ? []
        : [target.workspace, ...shard.dependentBatch].flatMap((workspace) => [
            "--workspace",
            workspace,
          ]);
      const executionDirectory = target.isolatedDirectory
        ? path.join(options.repoRoot, target.isolatedDirectory)
        : options.repoRoot;
      const command = [
        process.execPath,
        options.knipBin,
        "--directory",
        executionDirectory,
        "--config",
        configFile,
        ...(target.tsConfig
          ? ["--tsConfig", path.join(options.repoRoot, target.tsConfig)]
          : []),
        ...workspaceArgs,
        "--reporter",
        "json",
        "--no-progress",
        "--no-exit-code",
      ];
      const result = spawnSync(command[0], command.slice(1), {
        cwd: executionDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          DOTENV_CONFIG_QUIET: "true",
          NODE_OPTIONS: `--max-old-space-size=${OLD_SPACE_CEILING_MIB}`,
        },
        maxBuffer: 256 * 1024 * 1024,
      });
      const failure = infrastructureFailure(result, target.workspace);
      let report = null;
      let findings = [];
      if (!failure) {
        report = validateKnipReport(result.stdout, target.workspace);
        findings = findingInventory(
          target.workspace,
          report,
          workspaceDirs,
          target.isolatedDirectory,
        );
        successfulShardFindings.push(findings);
      }
      const execution = {
        shardIndex: shard.shardIndex,
        dependentBatch: shard.dependentBatch,
        dependentSourceFileCount: shard.dependentSourceFileCount,
        allowedWorkspaces: shard.allowedWorkspaces,
        executionDirectory,
        status: failure ? "failed" : "completed",
        failure,
        oom: failure === "out of memory",
        exitCode: result.status,
        signal: result.signal,
        elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        memoryCeilingMiB: OLD_SPACE_CEILING_MIB,
        configDigest,
        command,
        stdout: failure ? (result.stdout ?? "") : "",
        stderr: result.stderr ?? "",
        findingCount: findings.length,
      };
      shardExecutions.push(execution);
      atomicWrite(
        options.repoRoot,
        `${options.reportsDir}/workspaces/${slug}--${shardLabel}.json`,
        stableJson({ target: target.workspace, execution, findings, report }),
      );
    }
    const completed = shardExecutions.every(
      ({ status }) => status === "completed",
    );
    const findings = completed
      ? aggregateShardFindings(successfulShardFindings)
      : [];
    if (completed) aggregateFindings.push(...findings);
    executions.push({
      index: target.index,
      workspace: target.workspace,
      source: target.source,
      sourceFileCount: target.sourceFileCount,
      isolatedDirectory: target.isolatedDirectory,
      tsConfig: target.tsConfig,
      status: completed ? "completed" : "failed",
      directDependents: target.directDependents,
      manifestDependents: target.manifestDependents,
      sourceDependents: target.sourceDependents,
      shardCount: target.shards.length,
      findingCount: findings.length,
      findings,
      shards: shardExecutions,
    });
    process.stdout.write(
      `[knip] ${target.index + 1}/${ledger.length} ${target.workspace}: ${completed ? "completed" : "failed"}, ${findings.length} findings across ${target.shards.length} shards\n`,
    );
  }

  aggregateFindings.sort((left, right) =>
    compareText(stableJson(left), stableJson(right)),
  );
  const outcomeCounts = new Map();
  for (const execution of executions) {
    outcomeCounts.set(
      execution.workspace,
      (outcomeCounts.get(execution.workspace) ?? 0) + 1,
    );
  }
  const missingPartitions = ledger
    .map(({ workspace }) => workspace)
    .filter((workspace) => !outcomeCounts.has(workspace));
  const duplicatePartitions = [...outcomeCounts]
    .filter(([, count]) => count !== 1)
    .map(([workspace]) => workspace)
    .sort(compareText);
  const failedPartitions = executions
    .filter(({ status }) => status === "failed")
    .map(({ workspace }) => workspace);
  const oomPartitions = executions
    .filter(({ shards }) => shards.some(({ oom }) => oom))
    .map(({ workspace }) => workspace);
  const infrastructureFailed =
    failedPartitions.length > 0 ||
    missingPartitions.length > 0 ||
    duplicatePartitions.length > 0;
  const strictFindingFailure = options.strict && aggregateFindings.length > 0;
  const complete = !infrastructureFailed;
  const status = complete && !strictFindingFailure ? "completed" : "failed";
  const inventory = {
    schemaVersion: 2,
    status,
    complete,
    memoryCeilingMiB: OLD_SPACE_CEILING_MIB,
    dependentBatchSize: DEPENDENT_BATCH_SIZE,
    dependentSourceFileLimit: DEPENDENT_SOURCE_FILE_LIMIT,
    partitionCount: ledger.length,
    ledger: ledger.map(
      ({
        index,
        workspace,
        source,
        sourceFileCount,
        isolatedDirectory,
        tsConfig,
        directDependents,
        manifestDependents,
        sourceDependents,
        shards,
      }) => ({
        index,
        workspace,
        source,
        sourceFileCount,
        isolatedDirectory,
        tsConfig,
        directDependents,
        manifestDependents,
        sourceDependents,
        shards,
      }),
    ),
    outcomes: {
      failedPartitions,
      missingPartitions,
      duplicatePartitions,
      oomPartitions,
    },
    findingCount: aggregateFindings.length,
    findings: aggregateFindings,
  };
  atomicWrite(options.repoRoot, aggregateRelative, stableJson(inventory));
  const run = {
    schemaVersion: 2,
    mode: options.strict ? "strict" : "advisory",
    status,
    complete,
    infrastructureFailed,
    strictFindingFailure,
    outcomes: inventory.outcomes,
    elapsedMs: executions.reduce(
      (total, execution) =>
        total +
        execution.shards.reduce((sum, shard) => sum + shard.elapsedMs, 0),
      0,
    ),
    executions,
  };
  atomicWrite(options.repoRoot, runRelative, stableJson(run));
  process.stdout.write(
    `[knip] ${ledger.length} partitions, ${aggregateFindings.length} findings, ${status}\n`,
  );
  return status === "completed" ? 0 : 1;
}

function runPartitionedKnip(rawOptions) {
  const options = { ...parseArgs([]), ...rawOptions };
  options.repoRoot = path.resolve(options.repoRoot);
  options.knipBin = path.resolve(options.knipBin);
  const releaseLock = acquireReportLock(options.repoRoot, options.reportsDir);
  try {
    return runLocked(options);
  } finally {
    releaseLock();
  }
}

function main() {
  return runPartitionedKnip(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    // error-policy:J1 the command boundary makes incomplete audit evidence fail
    process.stderr.write(
      `[knip] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

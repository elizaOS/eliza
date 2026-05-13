#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASELINE_BUNDLED_RUNTIME_PACKAGES,
  discoverAlwaysBundledPackages,
  discoverRuntimePackages,
  shouldBundleDiscoveredPackage,
} from "./runtime-package-manifest";

type Options = {
  scanDir: string;
  targetDist: string;
};

type DependencyEntry = {
  name: string;
  spec: string | null;
};

type QueueEntry = DependencyEntry & {
  requesterDir: string;
  requesterDestDir: string;
};

type ResolvedPackage = {
  packageJsonPath: string;
  sourceDir: string;
};

type PackagePlatformManifest = {
  cpu?: string[];
  libc?: string[];
  os?: string[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const ROOT_NODE_MODULES = path.join(ROOT, "node_modules");
const ROOT_BUN_NODE_MODULES = path.join(ROOT_NODE_MODULES, ".bun");
const PACKAGE_JSON_PATH = path.join(ROOT, "package.json");
const REGISTRY_PACKAGE_CACHE = path.join(
  os.tmpdir(),
  "eliza-runtime-package-cache",
);
const TRACKED_PACKAGE_CACHE = path.join(
  os.tmpdir(),
  "eliza-tracked-package-cache",
);
const PUBLISHED_PACKAGE_FETCH_TIMEOUT_MS = 10_000;
const ALLOW_REGISTRY_FETCH =
  process.env.ELIZA_RUNTIME_COPY_ALLOW_REGISTRY_FETCH === "1";
const DEP_SKIP = new Set(["typescript", "@types/node", "lucide-react"]);
const ALWAYS_HOISTED_PACKAGES = new Set(["@elizaos/core"]);
const PACKAGED_DEPENDENCY_SKIPS = new Map<string, Set<string>>();
const RUNTIME_COPY_PRUNED_DIR_NAMES = new Set([
  ".git",
  ".gradle",
  ".github",
  ".turbo",
  "benchmark",
  "benchmarks",
  "coverage",
  "doc",
  "docs",
  "example",
  "examples",
  "test",
  "tests",
  "__tests__",
]);
const RUNTIME_COPY_PRUNED_FILE_EXTENSIONS = new Set([
  ".html",
  ".map",
  ".md",
  ".markdown",
  ".tsbuildinfo",
  ".txt",
]);
const TAR_SAFE_RELATIVE_PATH_MAX = Number.parseInt(
  process.env.ELIZA_RUNTIME_TAR_SAFE_RELATIVE_PATH_MAX ?? "202",
  10,
);
const TAR_SAFE_BASENAME_MAX = Number.parseInt(
  process.env.ELIZA_RUNTIME_TAR_SAFE_BASENAME_MAX ?? "100",
  10,
);
const PLATFORM_ALIASES = new Map<string, string>([
  ["android", "android"],
  ["aix", "aix"],
  ["darwin", "darwin"],
  ["freebsd", "freebsd"],
  ["ios", "ios"],
  ["linux", "linux"],
  ["mac", "darwin"],
  ["macos", "darwin"],
  ["netbsd", "netbsd"],
  ["openbsd", "openbsd"],
  ["osx", "darwin"],
  ["sunos", "sunos"],
  ["win", "win32"],
  ["windows", "win32"],
  ["win32", "win32"],
]);
const LIBC_ALIASES = new Map<string, string>([
  ["glibc", "glibc"],
  ["gnu", "glibc"],
  ["musl", "musl"],
]);
const ARCH_ALIASES = new Map<string, string>([
  ["aarch64", "arm64"],
  ["all", "universal"],
  ["amd64", "x64"],
  ["arm", "arm"],
  ["arm64", "arm64"],
  ["armv7", "arm"],
  ["armv7l", "arm"],
  ["i386", "ia32"],
  ["ia32", "ia32"],
  ["universal", "universal"],
  ["universal2", "universal"],
  ["x64", "x64"],
  ["x86", "ia32"],
  ["x86_64", "x64"],
]);
const bunPackageIndex = new Map<string, Set<string>>();
const registryPackageIndex = new Map<string, ResolvedPackage>();
const trackedPackageIndex = new Map<string, ResolvedPackage>();
const workspacePackageIndex = new Map<string, ResolvedPackage[]>();
let workspacePackageIndexBuilt = false;

function isRequiredRuntimeDocDirectory(entryPath: string): boolean {
  const normalizedPath = entryPath.split(path.sep).join("/");
  return (
    normalizedPath.endsWith("/yaml/dist/doc") ||
    normalizedPath.endsWith("/viem/_esm/actions/test") ||
    normalizedPath.endsWith("/viem/actions/test")
  );
}

function parseArgs(argv: string[]): Options {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.trim();
    const value = inlineValue ?? argv[i + 1];
    if (!inlineValue) i += 1;
    opts[key] = value;
  }

  const scanDir = path.resolve(ROOT, opts["scan-dir"] ?? "dist");
  const targetDist = path.resolve(ROOT, opts["target-dist"] ?? scanDir);
  return { scanDir, targetDist };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function packagePath(name: string, baseDir: string): string {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.split("/");
    return path.join(baseDir, scope, pkg);
  }
  return path.join(baseDir, name);
}

function addWorkspacePackageCandidate(
  name: string,
  resolved: ResolvedPackage,
): void {
  const existing = workspacePackageIndex.get(name);
  if (!existing) {
    workspacePackageIndex.set(name, [resolved]);
    return;
  }

  if (
    existing.some(
      (entry) =>
        entry.sourceDir === resolved.sourceDir ||
        entry.packageJsonPath === resolved.packageJsonPath,
    )
  ) {
    return;
  }

  existing.push(resolved);
}

function readWorkspacePatterns(packageJsonPath: string): string[] {
  type WorkspaceManifest = {
    workspaces?: string[] | { packages?: string[] };
  };

  try {
    const manifest = readJson<WorkspaceManifest>(packageJsonPath);
    if (Array.isArray(manifest.workspaces)) {
      return manifest.workspaces;
    }
    if (Array.isArray(manifest.workspaces?.packages)) {
      return manifest.workspaces.packages;
    }
  } catch {
    return [];
  }

  return [];
}

function expandWorkspacePattern(baseDir: string, pattern: string): string[] {
  const normalized = pattern.split(/[\\/]+/).filter(Boolean);
  const results: string[] = [];

  const visit = (segmentIndex: number, currentDir: string): void => {
    if (segmentIndex >= normalized.length) {
      results.push(currentDir);
      return;
    }

    const segment = normalized[segmentIndex];
    if (segment === "*") {
      if (!fs.existsSync(currentDir)) {
        return;
      }
      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        visit(segmentIndex + 1, path.join(currentDir, entry.name));
      }
      return;
    }

    if (segment.includes("*")) {
      const matcher = new RegExp(
        `^${segment
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      );
      if (!fs.existsSync(currentDir)) {
        return;
      }
      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !matcher.test(entry.name)) {
          continue;
        }
        visit(segmentIndex + 1, path.join(currentDir, entry.name));
      }
      return;
    }

    visit(segmentIndex + 1, path.join(currentDir, segment));
  };

  visit(0, baseDir);
  return results;
}

function indexWorkspacePackages(workspaceRoot: string): void {
  const workspacePackageJson = path.join(workspaceRoot, "package.json");
  const patterns = readWorkspacePatterns(workspacePackageJson);
  for (const pattern of patterns) {
    for (const candidateDir of expandWorkspacePattern(workspaceRoot, pattern)) {
      const packageJsonPath = path.join(candidateDir, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }

      try {
        const manifest = readJson<{ name?: string }>(packageJsonPath);
        if (typeof manifest.name !== "string" || !manifest.name.trim()) {
          continue;
        }
        addWorkspacePackageCandidate(manifest.name, {
          sourceDir: candidateDir,
          packageJsonPath,
        });
      } catch {
        // Ignore malformed workspace manifests during best-effort indexing.
      }
    }
  }
}

function buildWorkspacePackageIndex(): void {
  if (workspacePackageIndexBuilt) {
    return;
  }
  workspacePackageIndexBuilt = true;

  indexWorkspacePackages(ROOT);

  // The desktop wrapper repo builds from /eliza while the active Eliza
  // workspace lives at /eliza/eliza. Prefer those local packages over stale
  // published node_modules copies so deep runtime imports match the code that
  // tsdown just compiled.
  const nestedElizaRoot = path.join(ROOT, "eliza");
  if (
    nestedElizaRoot !== ROOT &&
    fs.existsSync(path.join(nestedElizaRoot, "package.json"))
  ) {
    indexWorkspacePackages(nestedElizaRoot);
  }
}

function addBunPackageCandidate(name: string, packageDir: string): void {
  const existing = bunPackageIndex.get(name);
  if (existing) {
    existing.add(packageDir);
    return;
  }

  bunPackageIndex.set(name, new Set([packageDir]));
}

function buildBunPackageIndex(): void {
  if (!fs.existsSync(ROOT_BUN_NODE_MODULES)) return;

  const entries = fs.readdirSync(ROOT_BUN_NODE_MODULES).sort();
  for (const entry of entries) {
    const nestedNodeModules = path.join(
      ROOT_BUN_NODE_MODULES,
      entry,
      "node_modules",
    );
    if (!fs.existsSync(nestedNodeModules)) continue;

    for (const child of fs.readdirSync(nestedNodeModules, {
      withFileTypes: true,
    })) {
      const childPath = path.join(nestedNodeModules, child.name);
      if (!child.isDirectory()) continue;

      if (child.name.startsWith("@")) {
        for (const scoped of fs.readdirSync(childPath, {
          withFileTypes: true,
        })) {
          if (!scoped.isDirectory()) continue;
          addBunPackageCandidate(
            `${child.name}/${scoped.name}`,
            path.join(childPath, scoped.name),
          );
        }
        continue;
      }

      addBunPackageCandidate(child.name, childPath);
    }
  }
}

function normalizeTargetOS(targetOS: string): string {
  return PLATFORM_ALIASES.get(targetOS.toLowerCase()) ?? targetOS.toLowerCase();
}

function normalizeTargetArch(targetArch: string): string {
  return ARCH_ALIASES.get(targetArch.toLowerCase()) ?? targetArch.toLowerCase();
}

function getRuntimeVariantConstraints(variant: string): {
  os: string | null;
  libc: string | null;
  arch: string | null;
} {
  const tokens = variant
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let os: string | null = null;
  let libc: string | null = null;
  let arch: string | null = null;

  for (const token of tokens) {
    if (!os) {
      os = PLATFORM_ALIASES.get(token) ?? null;
    }
    if (!libc) {
      libc = LIBC_ALIASES.get(token) ?? null;
    }
    if (!arch) {
      arch = ARCH_ALIASES.get(token) ?? null;
    }
  }

  return { os, libc, arch };
}

export function matchesRuntimeVariant(
  variant: string,
  targetOS = process.platform,
  targetArch = process.arch,
): boolean {
  const constraints = getRuntimeVariantConstraints(variant);
  if (!constraints.os && !constraints.libc && !constraints.arch) {
    return true;
  }

  const normalizedOS = normalizeTargetOS(targetOS);
  const normalizedArch = normalizeTargetArch(targetArch);

  if (constraints.os && constraints.os !== normalizedOS) {
    return false;
  }

  if (constraints.libc) {
    if (normalizedOS !== "linux") {
      return false;
    }
    const currentLibc = detectCurrentLibc();
    if (currentLibc && currentLibc !== constraints.libc) {
      return false;
    }
  }

  if (
    constraints.arch &&
    constraints.arch !== "universal" &&
    constraints.arch !== normalizedArch
  ) {
    return false;
  }

  return true;
}

function isPackageNameCompatibleWithCurrentPlatform(
  name: string,
  targetOS = process.platform,
  targetArch = process.arch,
): boolean {
  const runtimeVariantPackages = [
    /^@node-llama-cpp\/(.+)$/,
    /^@nomicfoundation\/edr-(.+)$/,
    /^@nomicfoundation\/solidity-analyzer-(.+)$/,
  ];

  for (const pattern of runtimeVariantPackages) {
    const match = name.match(pattern);
    if (match) {
      return matchesRuntimeVariant(match[1], targetOS, targetArch);
    }
  }

  return true;
}

export function shouldKeepPackageRelativePath(
  relativePath: string,
  targetOS = process.platform,
  targetArch = process.arch,
  packageName?: string,
): boolean {
  const normalizedPath = relativePath.split(path.sep).join("/");
  if (!normalizedPath || normalizedPath === ".") {
    return true;
  }

  if (packageName === "ffprobe-static") {
    const ffprobeMatch = normalizedPath.match(/^bin\/([^/]+)\/([^/]+)(?:\/|$)/);
    if (ffprobeMatch) {
      return matchesRuntimeVariant(`${ffprobeMatch[1]}-${ffprobeMatch[2]}`);
    }
  }

  if (packageName === "node-llama-cpp") {
    if (
      normalizedPath === "llama" ||
      normalizedPath.startsWith("llama/") ||
      normalizedPath === "templates" ||
      normalizedPath.startsWith("templates/")
    ) {
      return false;
    }
  }

  if (packageName === "onnxruntime-web") {
    if (normalizedPath === "lib" || normalizedPath.startsWith("lib/")) {
      return false;
    }
  }

  if (packageName === "@elizaos/app-core") {
    if (
      normalizedPath === ".tmp" ||
      normalizedPath.startsWith(".tmp/") ||
      normalizedPath === ".storybook" ||
      normalizedPath.startsWith(".storybook/") ||
      normalizedPath === "action-benchmark-report" ||
      normalizedPath.startsWith("action-benchmark-report/") ||
      normalizedPath === "skills/.cache" ||
      normalizedPath.startsWith("skills/.cache/")
    ) {
      return false;
    }
  }

  if (packageName === "@elizaos/app-companion") {
    if (
      normalizedPath === "public_src" ||
      normalizedPath.startsWith("public_src/")
    ) {
      return false;
    }
  }

  if (packageName === "@elizaos/agent") {
    if (
      normalizedPath === "dist-mobile" ||
      normalizedPath.startsWith("dist-mobile/")
    ) {
      return false;
    }
  }

  if (
    normalizedPath === "android/build" ||
    normalizedPath.startsWith("android/build/") ||
    normalizedPath === "ios/App/build" ||
    normalizedPath.startsWith("ios/App/build/")
  ) {
    return false;
  }
  const prebuildMatch = normalizedPath.match(
    /(?:^|\/)prebuilds\/([^/]+)(?:\/|$)/,
  );
  if (prebuildMatch) {
    return matchesRuntimeVariant(prebuildMatch[1], targetOS, targetArch);
  }

  const napiMatch = normalizedPath.match(
    /(?:^|\/)bin\/napi-v\d+\/([^/]+)(?:\/([^/]+))?(?:\/|$)/,
  );
  if (napiMatch) {
    const variant = [napiMatch[1], napiMatch[2]].filter(Boolean).join("-");
    return matchesRuntimeVariant(variant, targetOS, targetArch);
  }

  const koffiMatch = normalizedPath.match(
    /(?:^|\/)build\/koffi\/([^/]+)(?:\/|$)/,
  );
  if (koffiMatch) {
    return matchesRuntimeVariant(
      koffiMatch[1].replaceAll("_", "-"),
      targetOS,
      targetArch,
    );
  }

  const binsMatch = normalizedPath.match(/(?:^|\/)bins\/([^/]+)(?:\/|$)/);
  if (binsMatch) {
    const variant = binsMatch[1].replaceAll("_", "-");
    const constraints = getRuntimeVariantConstraints(variant);
    if (!constraints.os && !constraints.libc && !constraints.arch) {
      return true;
    }
    return matchesRuntimeVariant(variant, targetOS, targetArch);
  }

  return true;
}

function shouldPreservePrunedPackageEntry(
  packageName: string | undefined,
  packageDir: string | undefined,
  entryPath: string,
): boolean {
  if (packageName !== "@elevenlabs/elevenlabs-js" || !packageDir) {
    return false;
  }

  const relativePath = toPosixPath(path.relative(packageDir, entryPath));
  return (
    relativePath === "api/resources/conversationalAi/resources/tests" ||
    relativePath.startsWith(
      "api/resources/conversationalAi/resources/tests/",
    ) ||
    relativePath ===
      "serialization/resources/conversationalAi/resources/tests" ||
    relativePath.startsWith(
      "serialization/resources/conversationalAi/resources/tests/",
    )
  );
}

function pruneCopiedPackageDir(name: string, packageDir: string): void {
  if (!fs.existsSync(packageDir)) return;

  const visit = (currentDir: string): void => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(packageDir, entryPath);

      if (
        entry.name === "node_modules" ||
        (RUNTIME_COPY_PRUNED_DIR_NAMES.has(entry.name) &&
          !isRequiredRuntimeDocDirectory(entryPath) &&
          !shouldPreservePrunedPackageEntry(name, packageDir, entryPath))
      ) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        continue;
      }

      if (
        entry.isFile() &&
        RUNTIME_COPY_PRUNED_FILE_EXTENSIONS.has(path.extname(entry.name))
      ) {
        fs.rmSync(entryPath, { force: true });
        continue;
      }

      if (
        !shouldKeepPackageRelativePath(
          relativePath,
          process.platform,
          process.arch,
          name,
        )
      ) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        continue;
      }

      if (entry.isDirectory()) {
        visit(entryPath);
        if (fs.readdirSync(entryPath).length === 0) {
          fs.rmdirSync(entryPath);
        }
      }
    }
  };

  // Prune known multi-platform native payload directories after the copy lands.
  visit(packageDir);
}

function copyPackageDir(
  name: string,
  sourceDir: string,
  targetNodeModules: string,
  rootDestDir: string,
): boolean {
  const dest = packagePath(name, targetNodeModules);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const relativeDest = path.relative(sourceDir, dest);
  const destIsInsideSource =
    Boolean(relativeDest) &&
    !relativeDest.startsWith("..") &&
    !path.isAbsolute(relativeDest);
  const copyDest = destIsInsideSource
    ? fs.mkdtempSync(path.join(os.tmpdir(), "eliza-runtime-package-copy-"))
    : dest;
  const sourceDistDir = path.join(sourceDir, "dist");
  fs.cpSync(sourceDir, copyDest, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (entry) => {
      if (!shouldCopyPackageEntry(entry, name, sourceDir)) {
        return false;
      }
      if (name === "@elizaos/app-core") {
        const relativeEntry = path
          .relative(sourceDir, entry)
          .split(path.sep)
          .join("/");
        if (shouldSkipPackagedAppCoreEntry(relativeEntry)) {
          return false;
        }
      }
      if (!destIsInsideSource) {
        return true;
      }
      const relativeToDist = path.relative(sourceDistDir, entry);
      return (
        relativeToDist !== "" &&
        (relativeToDist.startsWith("..") || path.isAbsolute(relativeToDist))
      );
    },
  });
  if (destIsInsideSource) {
    fs.renameSync(copyDest, dest);
  }
  pruneCopiedPackageDir(name, dest);
  patchCopiedPackageRuntimeSurface(name, dest, rootDestDir);
  return true;
}

function shouldSkipPackagedAppCoreEntry(relativeEntry: string): boolean {
  return (
    relativeEntry === "packaging" ||
    relativeEntry.startsWith("packaging/") ||
    relativeEntry === "dist/packaging" ||
    relativeEntry.startsWith("dist/packaging/") ||
    relativeEntry === "platforms/android" ||
    relativeEntry.startsWith("platforms/android/") ||
    relativeEntry === "platforms/ios" ||
    relativeEntry.startsWith("platforms/ios/") ||
    relativeEntry === "dist/platforms/android" ||
    relativeEntry.startsWith("dist/platforms/android/") ||
    relativeEntry === "dist/platforms/ios" ||
    relativeEntry.startsWith("dist/platforms/ios/") ||
    relativeEntry === "platforms/electrobun/build" ||
    relativeEntry.startsWith("platforms/electrobun/build/") ||
    relativeEntry === "platforms/electrobun/artifacts" ||
    relativeEntry.startsWith("platforms/electrobun/artifacts/") ||
    relativeEntry === "dist/platforms/electrobun/build" ||
    relativeEntry.startsWith("dist/platforms/electrobun/build/") ||
    relativeEntry === "dist/platforms/electrobun/artifacts" ||
    relativeEntry.startsWith("dist/platforms/electrobun/artifacts/")
  );
}

type PackageJsonManifest = {
  exports?: Record<string, unknown>;
};

type AgentDeepImportExportEntry = {
  exportKey: string;
  jsPath: string;
  typesPath: string | null;
};

const AGENT_DEEP_IMPORT_EXPORT_DIRS = [
  "config",
  "providers",
  "runtime",
] as const;

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function collectAgentDeepImportExportEntries(
  sourceRoot: string,
): AgentDeepImportExportEntry[] {
  const entries: AgentDeepImportExportEntry[] = [];

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }

      if (
        !entry.isFile() ||
        !entry.name.endsWith(".js") ||
        entry.name.endsWith(".test.js")
      ) {
        continue;
      }

      const sourceRelative = toPosixPath(path.relative(sourceRoot, entryPath));
      const importPath = `./packages/agent/src/${sourceRelative}`;
      const typeFilePath = entryPath.replace(/\.js$/, ".d.ts");
      entries.push({
        exportKey: `./${sourceRelative.replace(/\.js$/, "")}`,
        jsPath: importPath,
        typesPath: fs.existsSync(typeFilePath)
          ? importPath.replace(/\.js$/, ".d.ts")
          : null,
      });
    }
  };

  for (const dirName of AGENT_DEEP_IMPORT_EXPORT_DIRS) {
    const sourceDir = path.join(sourceRoot, dirName);
    if (fs.existsSync(sourceDir)) {
      visit(sourceDir);
    }
  }

  return entries.sort((left, right) =>
    left.exportKey.localeCompare(right.exportKey),
  );
}

function patchCopiedAgentRuntimeExports(packageDir: string): void {
  const manifestPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    return;
  }

  const sourceRoot = path.join(packageDir, "packages", "agent", "src");
  if (!fs.existsSync(sourceRoot)) {
    return;
  }

  const manifest = readJson<PackageJsonManifest>(manifestPath);
  if (
    !manifest.exports ||
    typeof manifest.exports !== "object" ||
    Array.isArray(manifest.exports)
  ) {
    return;
  }

  let changed = false;
  for (const entry of collectAgentDeepImportExportEntries(sourceRoot)) {
    const exportValue = entry.typesPath
      ? {
          types: entry.typesPath,
          import: entry.jsPath,
          default: entry.jsPath,
        }
      : {
          import: entry.jsPath,
          default: entry.jsPath,
        };

    if (
      JSON.stringify(manifest.exports[entry.exportKey]) ===
      JSON.stringify(exportValue)
    ) {
      continue;
    }

    manifest.exports[entry.exportKey] = exportValue;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function rewriteJsStringSpecifiers(
  source: string,
  oldStem: string,
  newStem: string,
): string {
  return source
    .replaceAll(`"./${oldStem}"`, `"./${newStem}"`)
    .replaceAll(`'./${oldStem}'`, `'./${newStem}'`)
    .replaceAll(`"./${oldStem}.js"`, `"./${newStem}.js"`)
    .replaceAll(`'./${oldStem}.js'`, `'./${newStem}.js'`);
}

function rewriteQuotedJsSpecifier(
  source: string,
  oldSpecifier: string,
  newSpecifier: string,
): string {
  return source
    .replaceAll(`"${oldSpecifier}"`, `"${newSpecifier}"`)
    .replaceAll(`'${oldSpecifier}'`, `'${newSpecifier}'`);
}

function visitFiles(rootDir: string, visit: (filePath: string) => void): void {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      visitFiles(entryPath, visit);
      continue;
    }
    if (entry.isFile()) {
      visit(entryPath);
    }
  }
}

function tarRelativePath(rootDestDir: string, filePath: string): string {
  return path.relative(rootDestDir, filePath).split(path.sep).join("/");
}

function isTarSafeRelativePath(relativePath: string): boolean {
  return (
    relativePath.length <= TAR_SAFE_RELATIVE_PATH_MAX &&
    path.posix.basename(relativePath).length <= TAR_SAFE_BASENAME_MAX
  );
}

function relativeJsSpecifier(fromDir: string, toFile: string): string {
  let specifier = toPosixPath(path.relative(fromDir, toFile));
  if (!specifier.startsWith(".")) {
    specifier = `./${specifier}`;
  }
  return specifier;
}

function patchCopiedElevenLabsTarSafePaths(
  packageDir: string,
  rootDestDir: string,
): void {
  type Rename = {
    directory: string;
    oldPath: string;
    oldBase: string;
    oldStem: string;
    newPath: string;
    newBase: string;
    newStem: string;
  };

  const renames: Rename[] = [];
  visitFiles(packageDir, (filePath) => {
    if (!filePath.endsWith(".js")) {
      return;
    }

    const relativePath = tarRelativePath(rootDestDir, filePath);
    if (isTarSafeRelativePath(relativePath)) {
      return;
    }

    const oldBase = path.basename(filePath);
    const oldStem = oldBase.replace(/\.js$/, "");
    const newStem = `f_${shortHash(tarRelativePath(packageDir, filePath))}`;
    const newBase = `${newStem}.js`;
    const newPath = path.join(path.dirname(filePath), newBase);

    if (fs.existsSync(newPath)) {
      throw new Error(
        `[runtime-copy] generated duplicate tar-safe filename ${newPath}`,
      );
    }

    fs.renameSync(filePath, newPath);
    renames.push({
      directory: path.dirname(filePath),
      oldPath: filePath,
      oldBase,
      oldStem,
      newPath,
      newBase,
      newStem,
    });
  });

  if (renames.length === 0) {
    return;
  }

  visitFiles(packageDir, (filePath) => {
    if (!filePath.endsWith(".js")) {
      return;
    }

    let source = fs.readFileSync(filePath, "utf8");
    const original = source;
    const fileDir = path.dirname(filePath);
    for (const rename of renames) {
      const oldSpecifier = relativeJsSpecifier(fileDir, rename.oldPath);
      const newSpecifier = relativeJsSpecifier(fileDir, rename.newPath);
      source = rewriteQuotedJsSpecifier(source, oldSpecifier, newSpecifier);
      source = rewriteQuotedJsSpecifier(
        source,
        oldSpecifier.replace(/\.js$/, ""),
        newSpecifier.replace(/\.js$/, ""),
      );

      if (path.dirname(filePath) === rename.directory) {
        source = rewriteJsStringSpecifiers(
          source,
          rename.oldStem,
          rename.newStem,
        );
        source = rewriteJsStringSpecifiers(
          source,
          rename.oldBase,
          rename.newBase,
        );
      }
    }
    if (source !== original) {
      fs.writeFileSync(filePath, source);
    }
  });
}

function patchCopiedAiSdkProviderRuntimeSurface(packageDir: string): void {
  const distIndex = path.join(packageDir, "dist", "index.js");
  if (fs.existsSync(distIndex)) {
    fs.rmSync(path.join(packageDir, "src"), { recursive: true, force: true });
  }
}

function patchCopiedPackageRuntimeSurface(
  name: string,
  packageDir: string,
  rootDestDir: string,
): void {
  if (name === "@elizaos/agent") {
    patchCopiedAgentRuntimeExports(packageDir);
    return;
  }
  if (name === "@ai-sdk/provider") {
    patchCopiedAiSdkProviderRuntimeSurface(packageDir);
    return;
  }
  if (name === "@elevenlabs/elevenlabs-js") {
    patchCopiedElevenLabsTarSafePaths(packageDir, rootDestDir);
    return;
  }
}

export function shouldSkipPackagedDependency(
  requesterName: string,
  dependencyName: string,
): boolean {
  if (!isPackageNameCompatibleWithCurrentPlatform(dependencyName)) {
    return true;
  }

  return (
    PACKAGED_DEPENDENCY_SKIPS.get(requesterName)?.has(dependencyName) ?? false
  );
}

function isRecursivePackageSymlinkTarget(
  entry: string,
  resolvedTarget: string,
): boolean {
  let targetStats: fs.Stats;
  try {
    targetStats = fs.statSync(resolvedTarget);
  } catch {
    return true;
  }

  if (!targetStats.isDirectory()) {
    return false;
  }

  const relative = path.relative(resolvedTarget, entry);
  return (
    relative === "" ||
    (Boolean(relative) &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative))
  );
}

export function shouldCopyPackageEntry(
  entry: string,
  packageName?: string,
  packageRoot?: string,
): boolean {
  const basename = path.basename(entry);
  if (
    basename === "node_modules" ||
    (RUNTIME_COPY_PRUNED_DIR_NAMES.has(basename) &&
      !isRequiredRuntimeDocDirectory(entry) &&
      !shouldPreservePrunedPackageEntry(packageName, packageRoot, entry))
  ) {
    return false;
  }
  if (RUNTIME_COPY_PRUNED_FILE_EXTENSIONS.has(path.extname(entry))) {
    return false;
  }
  if (entry.endsWith(".d.ts") || entry.endsWith(".d.ts.map")) {
    return false;
  }

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(entry);
  } catch {
    return false;
  }

  if (!stats.isSymbolicLink()) {
    return true;
  }

  try {
    const resolvedTarget = path.resolve(
      path.dirname(entry),
      fs.readlinkSync(entry),
    );
    if (!fs.existsSync(resolvedTarget)) {
      return false;
    }
    return !isRecursivePackageSymlinkTarget(entry, resolvedTarget);
  } catch {
    return false;
  }
}

export function inferVersionFromBunEntryPath(
  packageDir: string,
): string | null {
  const normalized = packageDir.split(path.sep).join("/");
  const marker = "/.bun/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return null;

  const relative = normalized.slice(markerIndex + marker.length);
  const entry = relative.split("/", 1)[0];
  if (!entry) return null;

  const versionStart = entry.lastIndexOf("@");
  if (versionStart <= 0) return null;

  const versionEnd = entry.lastIndexOf("+");
  const version = entry.slice(
    versionStart + 1,
    versionEnd > versionStart ? versionEnd : undefined,
  );
  return version || null;
}

function registryCacheKey(name: string, version: string): string {
  return `${name.replaceAll("/", "__").replaceAll("@", "_")}@${version}`;
}

function relativeWorkspacePath(sourceDir: string): string | null {
  const relative = path.relative(ROOT, sourceDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function fetchPublishedPackage(
  name: string,
  version: string,
): ResolvedPackage | null {
  const key = `${name}@${version}`;
  const cached = registryPackageIndex.get(key);
  if (cached && fs.existsSync(cached.packageJsonPath)) return cached;

  const cacheDir = path.join(
    REGISTRY_PACKAGE_CACHE,
    registryCacheKey(name, version),
  );
  const packageRoot = path.join(cacheDir, "package");
  const manifestPath = path.join(packageRoot, "package.json");
  if (fs.existsSync(manifestPath)) {
    const resolved = { sourceDir: packageRoot, packageJsonPath: manifestPath };
    registryPackageIndex.set(key, resolved);
    return resolved;
  }

  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    const tarballName = execFileSync(
      "npm",
      ["pack", `${name}@${version}`, "--silent"],
      {
        cwd: cacheDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PUBLISHED_PACKAGE_FETCH_TIMEOUT_MS,
      },
    )
      .trim()
      .split(/\r?\n/)
      .pop();

    if (!tarballName) return null;

    execFileSync("tar", ["-xzf", tarballName, "-C", cacheDir], {
      cwd: cacheDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (!fs.existsSync(manifestPath)) return null;

    const resolved = { sourceDir: packageRoot, packageJsonPath: manifestPath };
    registryPackageIndex.set(key, resolved);
    return resolved;
  } catch {
    return null;
  }
}

function materializeTrackedWorkspacePackage(
  sourceDir: string,
): ResolvedPackage | null {
  const relative = relativeWorkspacePath(sourceDir);
  if (!relative) return null;

  const cached = trackedPackageIndex.get(relative);
  if (cached && fs.existsSync(cached.packageJsonPath)) return cached;

  const cacheDir = path.join(
    TRACKED_PACKAGE_CACHE,
    relative.replaceAll(path.sep, "__"),
  );
  const packageRoot = path.join(cacheDir, relative);
  const manifestPath = path.join(packageRoot, "package.json");
  if (fs.existsSync(manifestPath)) {
    const resolved = { sourceDir: packageRoot, packageJsonPath: manifestPath };
    trackedPackageIndex.set(relative, resolved);
    return resolved;
  }

  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    const archive = execFileSync(
      "git",
      ["archive", "--format=tar", "HEAD", relative],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    execFileSync("tar", ["-xf", "-", "-C", cacheDir], {
      input: archive,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!fs.existsSync(manifestPath)) return null;

    const resolved = { sourceDir: packageRoot, packageJsonPath: manifestPath };
    trackedPackageIndex.set(relative, resolved);
    return resolved;
  } catch {
    return null;
  }
}

function getPackageVersion(packageJsonPath: string): string | null {
  try {
    const pkg = readJson<{ version?: string }>(packageJsonPath);
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function isExactVersionSpecifier(
  spec: string | null | undefined,
): boolean {
  if (!spec) return false;
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec);
}

function canFetchPublishedPackage(spec: string | null | undefined): boolean {
  if (!spec) return false;
  return !(
    spec.startsWith("workspace:") ||
    spec.startsWith("file:") ||
    spec.startsWith("link:") ||
    spec.startsWith("portal:") ||
    spec.startsWith("patch:") ||
    spec.startsWith(".") ||
    spec.startsWith("/")
  );
}

function matchesPlatformSelector(
  selectors: string[] | undefined,
  current: string | null,
): boolean {
  if (!selectors || selectors.length === 0 || !current) {
    return true;
  }

  const blocked = selectors
    .filter((selector) => selector.startsWith("!"))
    .map((selector) => selector.slice(1));
  if (blocked.includes(current)) {
    return false;
  }

  const allowed = selectors.filter((selector) => !selector.startsWith("!"));
  if (allowed.length === 0) {
    return true;
  }

  return allowed.includes(current);
}

function detectCurrentLibc(): string | null {
  if (process.platform !== "linux") {
    return null;
  }

  try {
    const report = process.report?.getReport();
    return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
  } catch {
    return null;
  }
}

export function isPackageCompatibleWithCurrentPlatform(
  packageJsonPath: string,
): boolean {
  let manifest: PackagePlatformManifest;
  try {
    manifest = readJson<PackagePlatformManifest>(packageJsonPath);
  } catch {
    return true;
  }

  return (
    matchesPlatformSelector(manifest.os, process.platform) &&
    matchesPlatformSelector(manifest.cpu, process.arch) &&
    matchesPlatformSelector(manifest.libc, detectCurrentLibc())
  );
}

function collectInstalledPackageDirs(
  name: string,
  requesterDir: string,
  opts?: { includeWorkspace?: boolean },
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (candidate: string): void => {
    if (!fs.existsSync(candidate) || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  if (opts?.includeWorkspace !== false) {
    buildWorkspacePackageIndex();
    for (const candidate of workspacePackageIndex.get(name) ?? []) {
      addCandidate(candidate.sourceDir);
    }
  }

  let dir = requesterDir;
  while (true) {
    addCandidate(packagePath(name, path.join(dir, "node_modules")));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  addCandidate(packagePath(name, ROOT_NODE_MODULES));
  for (const candidate of bunPackageIndex.get(name) ?? []) {
    addCandidate(candidate);
  }

  return candidates;
}

function collectResolvedCandidates(
  name: string,
  requesterDir: string,
  opts?: { includeWorkspace?: boolean },
): ResolvedPackage[] {
  const resolved: ResolvedPackage[] = [];

  for (const sourceDir of collectInstalledPackageDirs(
    name,
    requesterDir,
    opts,
  )) {
    const normalized = normalizeResolvedPackage(sourceDir);
    if (normalized) resolved.push(normalized);
  }

  return resolved;
}

export function normalizeResolvedPackage(
  sourceDir: string,
): ResolvedPackage | null {
  let realSourceDir = sourceDir;
  try {
    realSourceDir = fs.realpathSync.native(sourceDir);
  } catch {
    realSourceDir = sourceDir;
  }

  const manifestPath = path.join(realSourceDir, "package.json");
  if (fs.existsSync(manifestPath)) {
    return { sourceDir: realSourceDir, packageJsonPath: manifestPath };
  }

  return materializeTrackedWorkspacePackage(realSourceDir);
}

export function selectResolvedCandidate(
  candidates: ResolvedPackage[],
  requestedSpec: string | null,
): ResolvedPackage | null {
  if (candidates.length === 0) return null;
  if (!isExactVersionSpecifier(requestedSpec)) {
    return candidates[0];
  }

  for (const candidate of candidates) {
    if (getPackageVersion(candidate.packageJsonPath) === requestedSpec) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolvePackage(
  name: string,
  requestedSpec: string | null,
  requesterDir: string,
  opts?: { includeWorkspace?: boolean },
): ResolvedPackage | null {
  const candidates = collectResolvedCandidates(name, requesterDir, opts);
  const selected = selectResolvedCandidate(candidates, requestedSpec);
  if (selected) return selected;

  if (ALLOW_REGISTRY_FETCH && canFetchPublishedPackage(requestedSpec)) {
    const fetched = fetchPublishedPackage(name, requestedSpec);
    if (fetched) return fetched;
  }

  if (candidates.length > 0) {
    return candidates[0];
  }

  for (const sourceDir of collectInstalledPackageDirs(
    name,
    requesterDir,
    opts,
  )) {
    let realSourceDir: string | null = null;
    try {
      realSourceDir = fs.realpathSync.native(sourceDir);
    } catch {
      realSourceDir = sourceDir;
    }

    const version =
      inferVersionFromBunEntryPath(realSourceDir) ??
      inferVersionFromBunEntryPath(sourceDir);
    if (!version) continue;

    if (!ALLOW_REGISTRY_FETCH) {
      continue;
    }

    const fetched = fetchPublishedPackage(name, version);
    if (fetched) return fetched;
  }

  return null;
}

export function getRuntimeDependencyEntries(
  pkgPath: string,
): DependencyEntry[] {
  const pkg = readJson<{
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  }>(pkgPath);
  const entries = new Map<string, string | null>();

  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (!DEP_SKIP.has(name)) {
      entries.set(name, spec);
    }
  }

  for (const [name, spec] of Object.entries(pkg.optionalDependencies ?? {})) {
    if (!DEP_SKIP.has(name) && !entries.has(name)) {
      entries.set(name, spec);
    }
  }

  for (const [name, spec] of Object.entries(pkg.peerDependencies ?? {})) {
    if (DEP_SKIP.has(name) || entries.has(name)) {
      continue;
    }

    const meta = pkg.peerDependenciesMeta?.[name];
    if (meta?.optional) {
      continue;
    }

    entries.set(name, spec);
  }

  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, spec]) => ({ name, spec }));
}

export function getRuntimeDependencies(pkgPath: string): string[] {
  return getRuntimeDependencyEntries(pkgPath).map((entry) => entry.name);
}

type CopyTargetOptions = {
  name: string;
  requesterDestDir: string;
  rootDestDir: string;
  targetNodeModules: string;
  topLevelVersions: ReadonlyMap<string, string | null>;
  resolvedVersion: string | null;
};

export function selectCopyTargetNodeModules({
  name,
  requesterDestDir,
  rootDestDir,
  targetNodeModules,
  topLevelVersions,
  resolvedVersion,
}: CopyTargetOptions): string {
  if (requesterDestDir === rootDestDir) {
    return targetNodeModules;
  }

  if (ALWAYS_HOISTED_PACKAGES.has(name) && topLevelVersions.has(name)) {
    return targetNodeModules;
  }

  if (!topLevelVersions.has(name)) {
    return targetNodeModules;
  }

  const topLevelVersion = topLevelVersions.get(name);
  if (topLevelVersion === resolvedVersion) {
    return targetNodeModules;
  }

  return path.join(requesterDestDir, "node_modules");
}

function copyPgliteCompatibilityAssets(targetDist: string): void {
  const pgliteDist = path.join(
    ROOT_NODE_MODULES,
    "@electric-sql",
    "pglite",
    "dist",
  );
  if (!fs.existsSync(pgliteDist)) return;

  for (const file of [
    "pglite.data",
    "pglite.wasm",
    "vector.tar.gz",
    "fuzzystrmatch.tar.gz",
  ]) {
    const src = path.join(pgliteDist, file);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(targetDist, file);
    fs.copyFileSync(src, dest);
  }
}

function assertTarSafeRuntimePaths(targetDist: string): void {
  const unsafe: string[] = [];

  const visit = (currentDir: string): void => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      const relativePath = tarRelativePath(targetDist, entryPath);
      if (!isTarSafeRelativePath(relativePath)) {
        unsafe.push(relativePath);
        if (unsafe.length >= 20) {
          return;
        }
      }
      if (entry.isDirectory()) {
        visit(entryPath);
        if (unsafe.length >= 20) {
          return;
        }
      }
    }
  };

  visit(targetDist);
  if (unsafe.length > 0) {
    throw new Error(
      [
        "[runtime-copy] runtime bundle contains tar-unsafe paths for the Electrobun self-extractor.",
        `Limit relative path length to <= ${TAR_SAFE_RELATIVE_PATH_MAX} and basename length to <= ${TAR_SAFE_BASENAME_MAX}.`,
        ...unsafe.map((entry) => `  ${entry.length} ${entry}`),
      ].join("\n"),
    );
  }
}

function main(): void {
  const { scanDir, targetDist } = parseArgs(process.argv.slice(2));
  const targetNodeModules = path.join(targetDist, "node_modules");

  if (!fs.existsSync(scanDir)) {
    throw new Error(`scan dir does not exist: ${scanDir}`);
  }
  if (!fs.existsSync(ROOT_NODE_MODULES)) {
    throw new Error(`root node_modules does not exist: ${ROOT_NODE_MODULES}`);
  }

  buildBunPackageIndex();

  fs.rmSync(targetNodeModules, { recursive: true, force: true });
  fs.mkdirSync(targetNodeModules, { recursive: true });

  const alwaysBundled = new Set(
    discoverAlwaysBundledPackages(PACKAGE_JSON_PATH),
  );
  for (const packageName of BASELINE_BUNDLED_RUNTIME_PACKAGES) {
    if (alwaysBundled.has(packageName)) {
      continue;
    }
    if (resolvePackage(packageName, null, ROOT, { includeWorkspace: false })) {
      alwaysBundled.add(packageName);
    }
  }
  const rootDependencySpecs = new Map(
    getRuntimeDependencyEntries(PACKAGE_JSON_PATH).map((entry) => [
      entry.name,
      entry.spec,
    ]),
  );
  const filteredOptionalPlugins = new Set<string>();
  const discovered = new Set(
    discoverRuntimePackages(scanDir).filter((packageName) => {
      const shouldBundle = shouldBundleDiscoveredPackage(
        packageName,
        alwaysBundled,
      );
      if (!shouldBundle) {
        filteredOptionalPlugins.add(packageName);
      }
      return shouldBundle;
    }),
  );
  const queue: QueueEntry[] = [...new Set([...alwaysBundled, ...discovered])]
    .sort()
    .map((name) => ({
      name,
      spec: rootDependencySpecs.get(name) ?? null,
      requesterDir: ROOT,
      requesterDestDir: targetDist,
    }));

  const copiedDestinations = new Set<string>();
  const copiedNames = new Set<string>();
  const missingAlwaysBundled = new Set<string>();
  const missingDiscovered = new Set<string>();
  const topLevelVersions = new Map<string, string | null>();

  while (queue.length > 0) {
    const request = queue.shift();
    if (!request) continue;

    const { name, spec, requesterDir, requesterDestDir } = request;
    if (
      !name ||
      DEP_SKIP.has(name) ||
      !isPackageNameCompatibleWithCurrentPlatform(name)
    ) {
      continue;
    }

    const resolved = resolvePackage(name, spec, requesterDir);
    if (!resolved) {
      if (alwaysBundled.has(name)) {
        missingAlwaysBundled.add(name);
      } else {
        missingDiscovered.add(name);
      }
      continue;
    }

    if (!isPackageCompatibleWithCurrentPlatform(resolved.packageJsonPath)) {
      missingAlwaysBundled.delete(name);
      missingDiscovered.delete(name);
      continue;
    }

    const resolvedVersion = getPackageVersion(resolved.packageJsonPath);
    const copyTargetNodeModules = selectCopyTargetNodeModules({
      name,
      requesterDestDir,
      rootDestDir: targetDist,
      targetNodeModules,
      topLevelVersions,
      resolvedVersion,
    });
    const destination = packagePath(name, copyTargetNodeModules);

    if (copiedDestinations.has(destination)) {
      missingAlwaysBundled.delete(name);
      missingDiscovered.delete(name);
      copiedNames.add(name);
      continue;
    }

    if (
      !copyPackageDir(
        name,
        resolved.sourceDir,
        copyTargetNodeModules,
        targetDist,
      )
    ) {
      if (alwaysBundled.has(name)) {
        missingAlwaysBundled.add(name);
      } else {
        missingDiscovered.add(name);
      }
      continue;
    }

    missingAlwaysBundled.delete(name);
    missingDiscovered.delete(name);
    copiedDestinations.add(destination);
    copiedNames.add(name);
    if (copyTargetNodeModules === targetNodeModules) {
      topLevelVersions.set(name, resolvedVersion);
    }

    for (const dep of getRuntimeDependencyEntries(resolved.packageJsonPath)) {
      if (shouldSkipPackagedDependency(name, dep.name)) {
        continue;
      }

      queue.push({
        name: dep.name,
        spec: dep.spec,
        requesterDir: resolved.sourceDir,
        requesterDestDir: destination,
      });
    }
  }

  copyPgliteCompatibilityAssets(targetDist);
  assertTarSafeRuntimePaths(targetDist);

  console.log(
    `[runtime-copy] bundled ${copiedNames.size} package(s) into ${targetNodeModules}`,
  );
  for (const name of [...copiedNames].sort()) {
    console.log(`  copied ${name}`);
  }

  if (missingAlwaysBundled.size > 0) {
    throw new Error(
      `[runtime-copy] missing installed runtime package(s): ${[...missingAlwaysBundled].sort().join(", ")}`,
    );
  }

  if (missingDiscovered.size > 0) {
    console.warn(
      `[runtime-copy] skipped unresolved optional package(s): ${[...missingDiscovered].sort().join(", ")}`,
    );
  }

  if (filteredOptionalPlugins.size > 0) {
    console.log(
      `[runtime-copy] excluded post-release plugin package(s): ${[...filteredOptionalPlugins].sort().join(", ")}`,
    );
  }
}

/**
 * Defense-in-depth check run after the copy + prune phases. Verifies that
 * every package in `alwaysBundled` has a `package.json` on disk inside
 * `nodeModulesDir`. Throws with the full list of missing packages so ops
 * can locate the exact expected path without guessing.
 */
export function assertRequiredBundledPackagesLanded(
  nodeModulesDir: string,
  alwaysBundled: Set<string>,
): void {
  const missing: string[] = [];

  for (const pkg of alwaysBundled) {
    const pkgJsonPath = pkg.startsWith("@")
      ? path.join(nodeModulesDir, ...pkg.split("/"), "package.json")
      : path.join(nodeModulesDir, pkg, "package.json");

    if (!fs.existsSync(pkgJsonPath)) {
      missing.push(
        `  ${pkg} (expected at ${pkgJsonPath})`,
      );
    }
  }

  if (missing.length > 0) {
    throw new Error(
      [
        `${missing.length} required runtime package(s) are missing from ${nodeModulesDir} after copy+prune:`,
        ...missing,
      ].join("\n"),
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}

#!/usr/bin/env -S node --import tsx
/** Supports app-core build, packaging, or development orchestration for copy runtime node modules ts. */

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
const RM_PATH_RECURSIVE_SCRIPT = path.join(
  ROOT,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);
const PUBLISHED_PACKAGE_FETCH_TIMEOUT_MS = 10_000;
const ALLOW_REGISTRY_FETCH =
  process.env.ELIZA_RUNTIME_COPY_ALLOW_REGISTRY_FETCH === "1";
const DEP_SKIP = new Set(["typescript", "@types/node"]);
const ALWAYS_HOISTED_PACKAGES = new Set([
  // @brighter/storage-adapter-s3 accepts broad S3 client ranges; reuse the
  // runtime root copy instead of nesting a private AWS SDK tree that exceeds
  // Electrobun's tar-safe path limits.
  "@aws-sdk/client-s3",
  "@elizaos/core",
  "commander",
  "pg",
  "pg-pool",
]);
const PATCH_COMPATIBLE_HOISTED_PACKAGES = new Set([
  "@walletconnect/core",
  "@walletconnect/sign-client",
  "@walletconnect/types",
  "@walletconnect/universal-provider",
  "@walletconnect/utils",
]);
const FORWARD_COMPATIBLE_HOISTED_PACKAGES = new Set([
  // The AWS SDK's Smithy packages are published in lockstep ranges. Reusing a
  // newer root copy avoids private nested trees whose paths exceed the desktop
  // self-extractor tar limits.
  "@smithy/core",
  "@smithy/signature-v4",
]);
const PACKAGED_DEPENDENCY_SKIPS = new Map<string, Set<string>>([
  // git-workspace-service declares @octokit/rest as both a dependency (^20)
  // and a peer (>=20). Desktop bundles it via plugin-agent-orchestrator,
  // which ships @octokit/rest@22 at the runtime root. Re-copying the private
  // Bun fallback produces tar-unsafe nested paths on Windows.
  ["git-workspace-service", new Set(["@octokit/rest"])],
]);
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
const RUNTIME_COPY_LOCK_TIMEOUT_MS = Number.parseInt(
  process.env.ELIZA_RUNTIME_COPY_LOCK_TIMEOUT_MS ?? "600000",
  10,
);
const RUNTIME_COPY_LOCK_STALE_MS = Number.parseInt(
  process.env.ELIZA_RUNTIME_COPY_LOCK_STALE_MS ?? "1800000",
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
let activeRuntimeCopyTargetNodeModules: string | null = null;

function resolveBunCommand(): string {
  return path.basename(process.execPath).startsWith("bun")
    ? process.execPath
    : (process.env.BUN ?? "bun");
}

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
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      }
    }
    if (value === undefined) continue;
    opts[key] = value;
  }

  const scanDir = path.resolve(ROOT, opts["scan-dir"] ?? "dist");
  const targetDist = path.resolve(ROOT, opts["target-dist"] ?? scanDir);
  return { scanDir, targetDist };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function isEnoentError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: string }).code === "ENOENT",
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: string }).code === "ESRCH"
    ) {
      return false;
    }
    return true;
  }
}

function readRuntimeCopyLockOwnerPid(lockDir: string): number | null {
  try {
    const owner = readJson<{ pid?: unknown }>(path.join(lockDir, "owner.json"));
    return typeof owner.pid === "number" && owner.pid > 0 ? owner.pid : null;
  } catch {
    return null;
  }
}

function recursiveRemoveErrorDetail(error: unknown): string {
  if (error && typeof error === "object") {
    const output = error as {
      message?: string;
      stderr?: unknown;
      stdout?: unknown;
    };
    const detail = [output.stdout, output.stderr]
      .filter(
        (chunk): chunk is Buffer | string =>
          Buffer.isBuffer(chunk) || typeof chunk === "string",
      )
      .map((chunk) => chunk.toString().trim())
      .filter(Boolean)
      .join("\n");
    if (detail) return detail;
    if (typeof output.message === "string") return output.message;
  }
  return String(error);
}

function runSharedRecursiveRemove(pathToRemove: string): void {
  try {
    execFileSync(
      "node",
      [RM_PATH_RECURSIVE_SCRIPT, path.resolve(pathToRemove)],
      {
        encoding: "utf8",
        stdio: "pipe",
      },
    );
  } catch (error) {
    throw new Error(recursiveRemoveErrorDetail(error), { cause: error });
  }
}

function rmRecursive(pathToRemove: string): void {
  try {
    runSharedRecursiveRemove(pathToRemove);
    return;
  } catch (error) {
    if (!fs.existsSync(pathToRemove)) {
      return;
    }

    const parentDir = path.dirname(pathToRemove);
    const tombstone = path.join(
      parentDir,
      `.${path.basename(pathToRemove)}.delete-${process.pid}-${Date.now()}`,
    );
    try {
      fs.renameSync(pathToRemove, tombstone);
    } catch {
      if (!fs.existsSync(pathToRemove)) {
        return;
      }
      throw error;
    }

    try {
      runSharedRecursiveRemove(tombstone);
    } catch (tombstoneError) {
      console.warn(
        `[runtime-copy] warning: moved retry-resistant path aside but could not fully remove ${tombstone}: ${recursiveRemoveErrorDetail(tombstoneError)}`,
      );
    }
  }
}

function acquireRuntimeCopyLock(targetDist: string): () => void {
  const lockDir = path.join(targetDist, ".runtime-copy.lock");
  const startedAt = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify(
          {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            targetDist,
          },
          null,
          2,
        )}\n`,
      );
      return () => {
        rmRecursive(lockDir);
      };
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        (error as { code?: string }).code !== "EEXIST"
      ) {
        throw error;
      }

      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
      } catch (statError) {
        if (isEnoentError(statError)) {
          continue;
        }
        throw statError;
      }

      const ownerPid = readRuntimeCopyLockOwnerPid(lockDir);
      if (ownerPid !== null && !isProcessAlive(ownerPid)) {
        rmRecursive(lockDir);
        continue;
      }

      if (ageMs > RUNTIME_COPY_LOCK_STALE_MS) {
        rmRecursive(lockDir);
        continue;
      }

      if (Date.now() - startedAt > RUNTIME_COPY_LOCK_TIMEOUT_MS) {
        throw new Error(
          `[runtime-copy] timed out waiting for runtime copy lock: ${lockDir}`,
        );
      }

      sleepSync(250);
    }
  }
}

function packagePath(name: string, baseDir: string): string {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.split("/");
    return path.join(baseDir, scope, pkg);
  }
  return path.join(baseDir, name);
}

function isPathInsideOrEqual(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
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
  const relativePath = packageDir
    ? toPosixPath(path.relative(packageDir, entryPath))
    : "";
  if (
    packageName === "@elizaos/skills" &&
    relativePath.startsWith("skills/") &&
    /\.(?:md|markdown)$/i.test(relativePath)
  ) {
    return true;
  }

  if (
    packageName === "googleapis" &&
    (relativePath === "build/src/apis/docs" ||
      relativePath.startsWith("build/src/apis/docs/"))
  ) {
    return true;
  }

  if (
    packageName === "three" &&
    (relativePath === "examples" ||
      relativePath === "examples/jsm" ||
      relativePath.startsWith("examples/jsm/") ||
      relativePath === "examples/fonts" ||
      relativePath.startsWith("examples/fonts/"))
  ) {
    return true;
  }

  if (
    packageName === "@elizaos/ui" &&
    (relativePath === "dist/cloud-ui/components/docs" ||
      relativePath.startsWith("dist/cloud-ui/components/docs/"))
  ) {
    return true;
  }

  if (packageName !== "@elevenlabs/elevenlabs-js" || !packageDir) {
    return false;
  }

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

function shouldPrunePackageRelativePath(
  packageName: string,
  relativePath: string,
): boolean {
  const normalizedPath = relativePath.split(path.sep).join("/");

  if (packageName === "@elizaos/plugin-local-inference") {
    return (
      normalizedPath === "native/llama.cpp/tools/server/webui" ||
      normalizedPath.startsWith("native/llama.cpp/tools/server/webui/") ||
      /^native\/llama\.cpp\/build(?:[-/]|$)/.test(normalizedPath) ||
      /^native\/omnivoice\.cpp\/build(?:[-/]|$)/.test(normalizedPath)
    );
  }

  return false;
}

function pruneCopiedPackageDir(name: string, packageDir: string): void {
  if (!fs.existsSync(packageDir)) return;

  const visit = (currentDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      if (isEnoentError(error)) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(packageDir, entryPath);

      if (shouldPrunePackageRelativePath(name, relativePath)) {
        rmRecursive(entryPath);
        continue;
      }

      if (
        entry.name === "node_modules" ||
        (RUNTIME_COPY_PRUNED_DIR_NAMES.has(entry.name) &&
          !isRequiredRuntimeDocDirectory(entryPath) &&
          !shouldPreservePrunedPackageEntry(name, packageDir, entryPath))
      ) {
        rmRecursive(entryPath);
        continue;
      }

      if (
        entry.isFile() &&
        RUNTIME_COPY_PRUNED_FILE_EXTENSIONS.has(path.extname(entry.name)) &&
        !shouldPreservePrunedPackageEntry(name, packageDir, entryPath)
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
        rmRecursive(entryPath);
        continue;
      }

      if (entry.isDirectory()) {
        visit(entryPath);
        if (
          fs.existsSync(entryPath) &&
          fs.readdirSync(entryPath).length === 0
        ) {
          fs.rmdirSync(entryPath);
        }
      }
    }
  };

  // Prune known multi-platform native payload directories after the copy lands.
  visit(packageDir);
}

function copyPackageDirSync(
  name: string,
  sourceDir: string,
  copyDest: string,
  destIsInsideSource: boolean,
): void {
  const sourceDistDir = path.join(sourceDir, "dist");
  const workspacePublishEntries = getWorkspacePackageRuntimeCopyEntries(
    name,
    sourceDir,
  );
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
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
          if (
            workspacePublishEntries &&
            !shouldCopyWorkspacePublishEntry(
              entry,
              sourceDir,
              workspacePublishEntries,
            )
          ) {
            return false;
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
      return;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        (error as { code?: string }).code === "ENAMETOOLONG"
      ) {
        throw new Error(
          `[runtime-copy] path too long while copying ${name} from ${sourceDir} to ${copyDest}`,
          { cause: error },
        );
      }
      if (!isEnoentError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      rmRecursive(copyDest);
      sleepSync(100 * (attempt + 1));
    }
  }
}

function copyPackageDir(
  name: string,
  sourceDir: string,
  targetNodeModules: string,
  rootDestDir: string,
): boolean {
  const dest = packagePath(name, targetNodeModules);
  rmRecursive(dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const relativeDest = path.relative(sourceDir, dest);
  const destIsInsideSource =
    Boolean(relativeDest) &&
    !relativeDest.startsWith("..") &&
    !path.isAbsolute(relativeDest);
  const copyDest = destIsInsideSource
    ? fs.mkdtempSync(path.join(os.tmpdir(), "eliza-runtime-package-copy-"))
    : dest;
  copyPackageDirSync(name, sourceDir, copyDest, destIsInsideSource);
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
    relativeEntry === "platforms/electrobun/src/libMacWindowEffects.dylib" ||
    relativeEntry === "dist/platforms/electrobun/build" ||
    relativeEntry.startsWith("dist/platforms/electrobun/build/") ||
    relativeEntry === "dist/platforms/electrobun/artifacts" ||
    relativeEntry.startsWith("dist/platforms/electrobun/artifacts/") ||
    relativeEntry ===
      "dist/platforms/electrobun/src/libMacWindowEffects.dylib" ||
    relativeEntry === "scripts/bun-riscv64" ||
    relativeEntry.startsWith("scripts/bun-riscv64/") ||
    relativeEntry === "dist/scripts/bun-riscv64" ||
    relativeEntry.startsWith("dist/scripts/bun-riscv64/")
  );
}

type PackageJsonManifest = {
  exports?: unknown;
  files?: unknown;
  main?: string;
  module?: string;
};

const PACKAGE_METADATA_ENTRY_NAMES = new Set([
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "README.md",
  "package.json",
]);
const NON_RUNTIME_EXPORT_CONDITIONS = new Set(["eliza-source", "types"]);

function getTopLevelPublishEntry(rawEntry: string): string | null {
  if (rawEntry.trim().startsWith("!")) {
    return null;
  }

  const normalized = rawEntry
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");

  if (!normalized || normalized === ".") {
    return null;
  }

  const [topLevel] = normalized.split("/");
  if (!topLevel || topLevel.includes("*")) {
    return null;
  }

  return topLevel;
}

function addRuntimeManifestEntryTopLevel(
  entries: Set<string>,
  entryPath: unknown,
): void {
  if (typeof entryPath !== "string" || !entryPath.startsWith("./")) {
    return;
  }

  const topLevel = getTopLevelPublishEntry(entryPath);
  if (topLevel) {
    entries.add(topLevel);
  }
}

function addRuntimeExportTopLevelEntries(
  entries: Set<string>,
  exportValue: unknown,
): void {
  if (typeof exportValue === "string") {
    addRuntimeManifestEntryTopLevel(entries, exportValue);
    return;
  }

  if (!exportValue || typeof exportValue !== "object") {
    return;
  }

  if (Array.isArray(exportValue)) {
    for (const item of exportValue) {
      addRuntimeExportTopLevelEntries(entries, item);
    }
    return;
  }

  for (const [condition, value] of Object.entries(exportValue)) {
    if (NON_RUNTIME_EXPORT_CONDITIONS.has(condition)) {
      continue;
    }
    addRuntimeExportTopLevelEntries(entries, value);
  }
}

function isWorkspacePackageSourceDir(sourceDir: string): boolean {
  const relative = path.relative(ROOT, sourceDir);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    !relative.split(path.sep).includes("node_modules")
  );
}

export function getWorkspacePackageRuntimeCopyEntries(
  name: string,
  sourceDir: string,
): Set<string> | null {
  if (!isWorkspacePackageSourceDir(sourceDir)) {
    return null;
  }

  const manifestPath = path.join(sourceDir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  const manifest = readJson<PackageJsonManifest>(manifestPath);
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.some((entry) => typeof entry !== "string")
  ) {
    return null;
  }

  const entries = new Set(PACKAGE_METADATA_ENTRY_NAMES);
  for (const fileEntry of manifest.files) {
    const topLevel = getTopLevelPublishEntry(fileEntry);
    if (topLevel) {
      entries.add(topLevel);
    }
  }

  addRuntimeManifestEntryTopLevel(entries, manifest.main);
  addRuntimeManifestEntryTopLevel(entries, manifest.module);
  addRuntimeExportTopLevelEntries(entries, manifest.exports);

  // @elizaos/agent still exposes Bun runtime source conditions. Keep its
  // source tree so packaged Bun resolution cannot select a missing entry.
  if (name === "@elizaos/agent" && fs.existsSync(path.join(sourceDir, "src"))) {
    entries.add("src");
  }

  return entries;
}

export function shouldCopyWorkspacePublishEntry(
  entry: string,
  sourceDir: string,
  allowedTopLevelEntries: ReadonlySet<string>,
): boolean {
  const relativeEntry = path.relative(sourceDir, entry);
  if (!relativeEntry) {
    return true;
  }

  const [topLevel] = relativeEntry.split(path.sep);
  return allowedTopLevelEntries.has(topLevel);
}

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

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      visitFiles(entryPath, visit);
      continue;
    }
    if (entry.isFile() && fs.existsSync(entryPath)) {
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
    if (!fs.existsSync(filePath)) {
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
    rmRecursive(path.join(packageDir, "src"));
  }
}

function writeRuntimeShimIfMissing(filePath: string, source: string): void {
  if (fs.existsSync(filePath)) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
}

function patchCopiedPluginSqlRuntimeSurface(packageDir: string): void {
  const srcDist = path.join(packageDir, "src", "dist");
  const nodeEntry = path.join(srcDist, "node", "index.node.js");
  if (!fs.existsSync(nodeEntry)) {
    return;
  }

  writeRuntimeShimIfMissing(
    path.join(srcDist, "index.js"),
    "export * from './node/index.node.js';\nexport { default } from './node/index.node.js';\n",
  );
  writeRuntimeShimIfMissing(
    path.join(srcDist, "drizzle", "index.js"),
    "export { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';\n",
  );
  writeRuntimeShimIfMissing(
    path.join(srcDist, "schema", "index.js"),
    "export * from '../node/index.node.js';\n",
  );
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
  if (name === "@elizaos/plugin-sql") {
    patchCopiedPluginSqlRuntimeSurface(packageDir);
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
  if (
    RUNTIME_COPY_PRUNED_FILE_EXTENSIONS.has(path.extname(entry)) &&
    !shouldPreservePrunedPackageEntry(packageName, packageRoot, entry)
  ) {
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

  rmRecursive(cacheDir);
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

  rmRecursive(cacheDir);
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
    const report = process.report.getReport();
    return report.header?.glibcVersionRuntime ? "glibc" : "musl";
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

function hasRootPackageOverride(name: string): boolean {
  try {
    const manifest = readJson<{
      overrides?: Record<string, unknown>;
      resolutions?: Record<string, unknown>;
    }>(PACKAGE_JSON_PATH);
    return (
      Object.hasOwn(manifest.overrides ?? {}, name) ||
      Object.hasOwn(manifest.resolutions ?? {}, name)
    );
  } catch {
    return false;
  }
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
    if (
      activeRuntimeCopyTargetNodeModules &&
      isPathInsideOrEqual(candidate, activeRuntimeCopyTargetNodeModules)
    ) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate);
  };

  if (opts?.includeWorkspace !== false) {
    buildWorkspacePackageIndex();
    for (const candidate of workspacePackageIndex.get(name) ?? []) {
      addCandidate(candidate.sourceDir);
    }
  }

  // Root overrides/resolutions are the package manager's answer for peers.
  // Prefer that install over requester-local Bun store fallbacks so runtime
  // packaging follows the same graph used by app-core builds.
  if (hasRootPackageOverride(name)) {
    addCandidate(packagePath(name, ROOT_NODE_MODULES));
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

function shouldHoistRuntimePackage(name: string): boolean {
  return ALWAYS_HOISTED_PACKAGES.has(name) || name.startsWith("@solana/");
}

function getMajorMinorVersion(version: string | null): string | null {
  if (!version) return null;
  const match = version.match(/^(\d+)\.(\d+)\./);
  return match ? `${match[1]}.${match[2]}` : null;
}

function parseSemverTriplet(
  version: string | null,
): [number, number, number] | null {
  if (!version) return null;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}

function isSameMajorVersionAtLeast(
  candidateVersion: string | null,
  minimumVersion: string | null,
): boolean {
  const candidate = parseSemverTriplet(candidateVersion);
  const minimum = parseSemverTriplet(minimumVersion);
  if (!candidate || !minimum || candidate[0] !== minimum[0]) {
    return false;
  }

  if (candidate[1] !== minimum[1]) {
    return candidate[1] > minimum[1];
  }
  return candidate[2] >= minimum[2];
}

function shouldReuseTopLevelRuntimePackage(
  name: string,
  topLevelVersion: string | null,
  resolvedVersion: string | null,
): boolean {
  if (topLevelVersion === resolvedVersion) {
    return true;
  }

  if (!PATCH_COMPATIBLE_HOISTED_PACKAGES.has(name)) {
    return (
      FORWARD_COMPATIBLE_HOISTED_PACKAGES.has(name) &&
      isSameMajorVersionAtLeast(topLevelVersion, resolvedVersion)
    );
  }

  const topLevelMajorMinor = getMajorMinorVersion(topLevelVersion);
  const resolvedMajorMinor = getMajorMinorVersion(resolvedVersion);
  return (
    topLevelMajorMinor !== null &&
    resolvedMajorMinor !== null &&
    topLevelMajorMinor === resolvedMajorMinor
  );
}

type CopyTargetOptions = {
  name: string;
  requesterDestDir: string;
  rootDestDir: string;
  targetNodeModules: string;
  topLevelVersions: ReadonlyMap<string, string | null>;
  resolvedVersion: string | null;
};

function findReusableAncestorNodeModules({
  name,
  requesterDestDir,
  rootDestDir,
  resolvedVersion,
}: Pick<
  CopyTargetOptions,
  "name" | "requesterDestDir" | "rootDestDir" | "resolvedVersion"
>): string | null {
  const root = path.resolve(rootDestDir);
  let currentDir = requesterDestDir;

  while (true) {
    const candidateNodeModules = path.join(currentDir, "node_modules");
    const candidatePackageDir = packagePath(name, candidateNodeModules);
    const candidateManifest = path.join(candidatePackageDir, "package.json");

    if (
      fs.existsSync(candidateManifest) &&
      getPackageVersion(candidateManifest) === resolvedVersion
    ) {
      return candidateNodeModules;
    }

    if (path.resolve(currentDir) === root) {
      return null;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

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

  if (shouldHoistRuntimePackage(name) && topLevelVersions.has(name)) {
    return targetNodeModules;
  }

  if (!topLevelVersions.has(name)) {
    return targetNodeModules;
  }

  const topLevelVersion = topLevelVersions.get(name) ?? null;
  if (
    shouldReuseTopLevelRuntimePackage(name, topLevelVersion, resolvedVersion)
  ) {
    return targetNodeModules;
  }

  const reusableAncestorNodeModules = findReusableAncestorNodeModules({
    name,
    requesterDestDir,
    rootDestDir,
    resolvedVersion,
  });
  if (reusableAncestorNodeModules) {
    return reusableAncestorNodeModules;
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

function isRuntimeManifestEntryPath(value: string): boolean {
  if (!value.startsWith("./") || value.includes("*")) {
    return false;
  }
  if (/\.(?:d\.)?ts$/i.test(value) || /\.d\.[cm]?ts$/i.test(value)) {
    return false;
  }
  return true;
}

function runtimeManifestEntryExists(
  packageDir: string,
  entryPath: string,
): boolean {
  const resolved = path.resolve(packageDir, entryPath);
  const relative = path.relative(packageDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  if (fs.existsSync(resolved)) {
    return true;
  }

  if (!path.extname(resolved)) {
    return [
      ".js",
      ".mjs",
      ".cjs",
      "/index.js",
      "/index.mjs",
      "/index.cjs",
    ].some((suffix) => fs.existsSync(`${resolved}${suffix}`));
  }

  return false;
}

function collectRuntimeExportEntryPaths(value: unknown): string[] {
  if (typeof value === "string") {
    return isRuntimeManifestEntryPath(value) ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectRuntimeExportEntryPaths(entry));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const hasSubpathKeys = entries.some(
    ([key]) => key === "." || key.startsWith("./"),
  );
  if (hasSubpathKeys) {
    return entries.flatMap(([, entry]) =>
      collectRuntimeExportEntryPaths(entry),
    );
  }

  return entries.flatMap(([condition, entry]) => {
    if (condition === "types" || condition === "typings") {
      return [];
    }
    return collectRuntimeExportEntryPaths(entry);
  });
}

function getRequiredRuntimeEntryPaths(pkgJsonPath: string): string[] {
  const manifest = readJson<PackageJsonManifest>(pkgJsonPath);
  const entries = new Set<string>();

  for (const entry of [manifest.main, manifest.module]) {
    if (typeof entry === "string" && isRuntimeManifestEntryPath(entry)) {
      entries.add(entry);
    }
  }

  for (const entry of collectRuntimeExportEntryPaths(manifest.exports)) {
    entries.add(entry);
  }

  return [...entries].sort();
}

function workspacePackageNeedsRuntimeBuild(packageJsonPath: string): boolean {
  for (const entryPath of getRequiredRuntimeEntryPaths(packageJsonPath)) {
    if (!runtimeManifestEntryExists(path.dirname(packageJsonPath), entryPath)) {
      return true;
    }
  }
  return false;
}

function packageHasBuildScript(packageJsonPath: string): boolean {
  try {
    const manifest = readJson<{ scripts?: Record<string, unknown> }>(
      packageJsonPath,
    );
    return typeof manifest.scripts?.build === "string";
  } catch {
    return false;
  }
}

function ensureWorkspaceRuntimeEntriesBuilt(
  packageNames: Iterable<string>,
): void {
  buildWorkspacePackageIndex();
  const built = new Set<string>();

  for (const packageName of [...new Set(packageNames)].sort()) {
    if (!isPackageNameCompatibleWithCurrentPlatform(packageName)) continue;

    for (const candidate of workspacePackageIndex.get(packageName) ?? []) {
      if (built.has(candidate.sourceDir)) continue;
      if (!isPackageCompatibleWithCurrentPlatform(candidate.packageJsonPath)) {
        continue;
      }
      if (!workspacePackageNeedsRuntimeBuild(candidate.packageJsonPath)) {
        continue;
      }
      if (!packageHasBuildScript(candidate.packageJsonPath)) {
        continue;
      }

      console.log(
        `[runtime-copy] building ${packageName} workspace runtime entries`,
      );
      try {
        execFileSync(resolveBunCommand(), ["run", "build"], {
          cwd: candidate.sourceDir,
          env: { ...process.env, FORCE_COLOR: "0" },
          stdio: "inherit",
        });
      } catch (error) {
        if (workspacePackageNeedsRuntimeBuild(candidate.packageJsonPath)) {
          throw error;
        }
        console.warn(
          `[runtime-copy] warning: ${packageName} build exited non-zero after producing required runtime entries; continuing`,
        );
      }
      built.add(candidate.sourceDir);
    }
  }
}

// Post-copy assertion: missingAlwaysBundled catches resolve failures, but
// can't catch a transitive-walk filter silently skipping a CORE plugin or
// pruneCopiedPackageDir removing a load-bearing package.json or entrypoint.
export function assertRequiredBundledPackagesLanded(
  targetNodeModules: string,
  alwaysBundled: ReadonlySet<string>,
): void {
  const missing: string[] = [];
  const missingEntrypoints: string[] = [];
  const baselinePackages = new Set(BASELINE_BUNDLED_RUNTIME_PACKAGES);
  for (const name of alwaysBundled) {
    if (!isPackageNameCompatibleWithCurrentPlatform(name)) continue;
    const packageDir = packagePath(name, targetNodeModules);
    const pkgJsonPath = path.join(packageDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) {
      missing.push(name);
      continue;
    }

    if (!baselinePackages.has(name)) {
      continue;
    }

    for (const entryPath of getRequiredRuntimeEntryPaths(pkgJsonPath)) {
      if (!runtimeManifestEntryExists(packageDir, entryPath)) {
        missingEntrypoints.push(
          `${name}  (missing runtime entry ${path.join(packageDir, entryPath)})`,
        );
      }
    }
  }
  if (missing.length === 0 && missingEntrypoints.length === 0) return;
  throw new Error(
    [
      `[runtime-copy] ${missing.length + missingEntrypoints.length} required runtime package check(s) failed after copy + prune:`,
      ...missing
        .sort()
        .map(
          (n) =>
            `  ${n}  (missing ${path.join(packagePath(n, targetNodeModules), "package.json")})`,
        ),
      ...missingEntrypoints.sort().map((entry) => `  ${entry}`),
      "This usually means a filter in the transitive-walk, build output, or a rule in pruneCopiedPackageDir accidentally excluded a required package entry. Bundle is unsafe to ship.",
    ].join("\n"),
  );
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
  activeRuntimeCopyTargetNodeModules = targetNodeModules;

  if (!fs.existsSync(scanDir)) {
    throw new Error(`scan dir does not exist: ${scanDir}`);
  }
  if (!fs.existsSync(ROOT_NODE_MODULES)) {
    throw new Error(`root node_modules does not exist: ${ROOT_NODE_MODULES}`);
  }

  buildBunPackageIndex();
  const releaseRuntimeCopyLock = acquireRuntimeCopyLock(targetDist);

  try {
    rmRecursive(targetNodeModules);
    fs.mkdirSync(targetNodeModules, { recursive: true });

    const alwaysBundled = new Set(
      discoverAlwaysBundledPackages(PACKAGE_JSON_PATH),
    );
    for (const packageName of BASELINE_BUNDLED_RUNTIME_PACKAGES) {
      if (alwaysBundled.has(packageName)) {
        continue;
      }
      if (
        resolvePackage(packageName, null, ROOT, { includeWorkspace: false })
      ) {
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
    ensureWorkspaceRuntimeEntriesBuilt([...alwaysBundled, ...discovered]);
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

        // Same filter as initial discovery: non-alwaysBundled plugins are
        // post-release-installable and must not enter the transitive walk.
        // Without this, a peerDep on an optional plugin drags its entire
        // deep tree (e.g. @solana/codecs* nested 8 levels) into the bundle
        // and trips assertTarSafeRuntimePaths.
        if (!shouldBundleDiscoveredPackage(dep.name, alwaysBundled)) {
          filteredOptionalPlugins.add(dep.name);
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
    assertRequiredBundledPackagesLanded(targetNodeModules, alwaysBundled);

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
  } finally {
    activeRuntimeCopyTargetNodeModules = null;
    releaseRuntimeCopyLock();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}

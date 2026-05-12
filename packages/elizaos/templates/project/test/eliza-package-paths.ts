import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

function shouldUseLocalEliza(repoRoot: string): boolean {
  const rawMode = (() => {
    if (process.env.ELIZA_SOURCE) return process.env.ELIZA_SOURCE;
    try {
      return require("node:fs")
        .readFileSync(path.join(repoRoot, ".elizaos/source-mode"), "utf8")
        .trim();
    } catch {
      return "packages";
    }
  })().toLowerCase();
  return ["local", "source", "workspace"].includes(rawMode);
}

function getRepoLocalWorkspaceRoot(
  packageName: string,
  repoRoot: string,
): string | undefined {
  if (!shouldUseLocalEliza(repoRoot)) return undefined;

  const relativeRoots: Record<string, string[]> = {
    "@elizaos/agent": ["eliza/packages/agent"],
    "@elizaos/app-core": ["eliza/packages/app-core"],
    "@elizaos/core": ["eliza/packages/core"],
    "@elizaos/shared": ["eliza/packages/shared"],
    "@elizaos/ui": ["eliza/packages/ui"],
    "@elizaos/app-companion": ["eliza/plugins/app-companion"],
  };

  for (const relativeRoot of relativeRoots[packageName] ?? []) {
    const candidate = path.resolve(repoRoot, relativeRoot);
    if (existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return undefined;
}

function getRequireFor(baseDir?: string) {
  return baseDir ? createRequire(path.join(baseDir, "package.json")) : require;
}

function firstExistingPath(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

export function resolveModuleEntry(basePath: string): string {
  if (existsSync(basePath)) return basePath;
  return (
    firstExistingPath(
      MODULE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ) ?? basePath
  );
}

export function getInstalledPackageRoot(
  packageName: string,
  fromDir?: string,
): string | undefined {
  if (fromDir) {
    const localPackage = getRepoLocalWorkspaceRoot(packageName, fromDir);
    if (localPackage) return localPackage;
  }

  const scopedRequire = getRequireFor(fromDir);

  try {
    return path.dirname(scopedRequire.resolve(`${packageName}/package.json`));
  } catch {
    try {
      return path.dirname(scopedRequire.resolve(packageName));
    } catch {
      return undefined;
    }
  }
}

function sourceRoot(packageRoot: string, nestedSource: string): string {
  if (path.basename(packageRoot) === "src") return packageRoot;
  const nested = path.join(packageRoot, nestedSource);
  if (existsSync(nested)) return nested;
  const direct = path.join(packageRoot, "src");
  return existsSync(direct) ? direct : packageRoot;
}

export function getInstalledPackageEntry(
  packageName: string,
  repoRoot: string,
  subpath?: "node",
): string | undefined {
  const packageRoot = getInstalledPackageRoot(packageName, repoRoot);
  if (!packageRoot) return undefined;

  const candidates =
    subpath === "node"
      ? [
          path.join(packageRoot, "dist/node/index.node"),
          path.join(packageRoot, "packages/core/src/index.node"),
          path.join(packageRoot, "src/index.node"),
          path.join(packageRoot, "index.node"),
        ]
      : [
          path.join(packageRoot, "packages/app-core/src/index"),
          path.join(packageRoot, "packages/shared/src/index"),
          path.join(packageRoot, "packages/ui/src/index"),
          path.join(packageRoot, "dist/index"),
          path.join(packageRoot, "src/index"),
          path.join(packageRoot, "index"),
        ];

  const resolved = candidates
    .map((candidate) => resolveModuleEntry(candidate))
    .find((candidate) => existsSync(candidate));
  return resolved ?? resolveModuleEntry(candidates[0]);
}

type ModuleNamespace = Record<string, unknown> & {
  default?: Record<string, unknown>;
};

function getNamedExport<T>(
  moduleNamespace: ModuleNamespace,
  exportName: string,
): T | undefined {
  if (exportName in moduleNamespace) return moduleNamespace[exportName] as T;
  const defaultNamespace = moduleNamespace.default;
  if (
    defaultNamespace &&
    typeof defaultNamespace === "object" &&
    exportName in defaultNamespace
  ) {
    return defaultNamespace[exportName] as T;
  }
  return undefined;
}

export async function getInstalledPackageNamedExport<T>(
  packageName: string,
  exportName: string,
  repoRoot: string,
  subpath?: "node",
): Promise<T> {
  const specifiers = subpath
    ? [`${packageName}/${subpath}`, packageName]
    : [packageName];
  const attempts: string[] = [];

  for (const specifier of specifiers) {
    try {
      const moduleNamespace = (await import(specifier)) as ModuleNamespace;
      const value = getNamedExport<T>(moduleNamespace, exportName);
      if (value !== undefined) return value;
    } catch (error) {
      attempts.push(
        `${specifier}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const entry = getInstalledPackageEntry(packageName, repoRoot, subpath);
  if (entry) {
    const moduleNamespace = (await import(
      pathToFileURL(entry).href
    )) as ModuleNamespace;
    const value = getNamedExport<T>(moduleNamespace, exportName);
    if (value !== undefined) return value;
  }

  throw new TypeError(
    `${exportName} export not found in ${packageName}. Tried: ${attempts.join(" | ")}`,
  );
}

export function getElizaCoreEntry(repoRoot: string): string | undefined {
  return getInstalledPackageEntry("@elizaos/core", repoRoot, "node");
}

export function getAutonomousSourceRoot(repoRoot: string): string | undefined {
  const packageRoot = getInstalledPackageRoot("@elizaos/agent", repoRoot);
  return packageRoot
    ? sourceRoot(packageRoot, "packages/agent/src")
    : undefined;
}

export function getAppCoreSourceRoot(repoRoot: string): string | undefined {
  const packageRoot = getInstalledPackageRoot("@elizaos/app-core", repoRoot);
  return packageRoot
    ? sourceRoot(packageRoot, "packages/app-core/src")
    : undefined;
}

export function getSharedSourceRoot(repoRoot: string): string | undefined {
  const packageRoot = getInstalledPackageRoot("@elizaos/shared", repoRoot);
  return packageRoot
    ? sourceRoot(packageRoot, "packages/shared/src")
    : undefined;
}

export function getUiSourceRoot(repoRoot: string): string | undefined {
  const packageRoot = getInstalledPackageRoot("@elizaos/ui", repoRoot);
  return packageRoot ? sourceRoot(packageRoot, "packages/ui/src") : undefined;
}

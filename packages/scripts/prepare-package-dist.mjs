/**
 * Produces the publishable manifest beside each compiled workspace package.
 * Workspace dependency versions come from the shared canonical discovery seam,
 * so nested tool manifests cannot impersonate a package.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRegistryFallbackTags } from "./lib/script-metadata.mjs";
import { listPackages } from "./lib/workspaces.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

export function collectWorkspaceVersions(rootDir) {
  const versions = new Map();
  for (const { name, packageJson } of listPackages({ repoRoot: rootDir })) {
    if (
      typeof name === "string" &&
      name.length > 0 &&
      typeof packageJson.version === "string" &&
      packageJson.version.length > 0
    ) {
      versions.set(name, packageJson.version);
    }
  }
  return versions;
}

export function preparePackageDist({
  repositoryRoot,
  packageDirectory,
  compiledPrefix = "",
  assetPrefix = "",
  skipLocalUpstreams = false,
  optionalPluginFallbackVersions,
}) {
  const normalizedCompiledPrefix = normalizePrefix(compiledPrefix);
  const normalizedAssetPrefix = normalizePrefix(assetPrefix);
  const packageDir = path.resolve(repositoryRoot, packageDirectory);
  const packageJsonPath = path.join(packageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const workspaceVersions = collectWorkspaceVersions(repositoryRoot);
  // Optional plugins declare their registry fallback tags in package metadata;
  // callers may inject the map so fixtures exercise the same rewrite boundary.
  const fallbackVersions =
    optionalPluginFallbackVersions ??
    resolveRegistryFallbackTags({ repoRoot: repositoryRoot });
  const rewriteOptions = { skipLocalUpstreams, fallbackVersions };

  const publishManifest = {
    ...packageJson,
    main: packageJson.main
      ? transformModulePath(packageJson.main, normalizedCompiledPrefix)
      : undefined,
    module: packageJson.module
      ? transformModulePath(packageJson.module, normalizedCompiledPrefix)
      : undefined,
    types: transformTypesPath(
      getRootTypesEntry(packageJson),
      normalizedCompiledPrefix,
    ),
    bin: transformBin(packageJson.bin, normalizedCompiledPrefix),
    exports: transformExports(
      packageJson.exports,
      normalizedCompiledPrefix,
      normalizedAssetPrefix,
    ),
    dependencies: rewriteWorkspaceDeps(
      packageJson.dependencies,
      workspaceVersions,
      rewriteOptions,
    ),
    peerDependencies: rewriteWorkspaceDeps(
      packageJson.peerDependencies,
      workspaceVersions,
      rewriteOptions,
    ),
    optionalDependencies: rewriteWorkspaceDeps(
      packageJson.optionalDependencies,
      workspaceVersions,
      rewriteOptions,
    ),
    publishConfig: {
      ...(packageJson.publishConfig ?? {}),
      access:
        packageJson.publishConfig?.access ??
        (String(packageJson.name).startsWith("@") ? "public" : undefined),
    },
  };

  delete publishManifest.private;
  delete publishManifest.scripts;
  delete publishManifest.devDependencies;
  delete publishManifest.workspaces;
  delete publishManifest.files;

  if (!publishManifest.exports?.["./package.json"]) {
    publishManifest.exports = {
      ...publishManifest.exports,
      "./package.json": "./package.json",
    };
  }
  if (!publishManifest.publishConfig?.access) {
    delete publishManifest.publishConfig;
  }

  const cleanedManifest = cleanUndefined(publishManifest);
  const distDir = path.join(packageDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    path.join(distDir, "package.json"),
    `${JSON.stringify(cleanedManifest, null, 2)}\n`,
  );
  return cleanedManifest;
}

function normalizePrefix(prefix) {
  return prefix.replace(/^\.?\//, "").replace(/\/+$/, "");
}

function getRootEntry(pkg) {
  const rootExport = pkg.exports?.["."];
  if (typeof rootExport === "string") {
    return rootExport;
  }
  if (typeof pkg.main === "string") {
    return pkg.main;
  }
  return "./src/index.ts";
}

function getRootTypesEntry(pkg) {
  if (typeof pkg.types === "string") {
    return pkg.types;
  }
  if (typeof pkg.typings === "string") {
    return pkg.typings;
  }
  return getRootEntry(pkg);
}

function rewriteWorkspaceDeps(section, versions, options) {
  if (!section) {
    return undefined;
  }

  const rewrittenEntries = [];
  for (const [name, version] of Object.entries(section)) {
    if (typeof version === "string" && version.startsWith("workspace:")) {
      const resolvedVersion = versions.get(name);
      if (!resolvedVersion) {
        if (options.skipLocalUpstreams) {
          const fallbackVersion = resolveWorkspaceFallbackVersion(
            name,
            options,
          );
          if (fallbackVersion) {
            rewrittenEntries.push([name, fallbackVersion]);
          }
          continue;
        }
        throw new Error(
          `no local version found for workspace dependency ${name}`,
        );
      }
      rewrittenEntries.push([
        name,
        normalizeWorkspaceVersion(version, resolvedVersion),
      ]);
      continue;
    }
    rewrittenEntries.push([name, version]);
  }

  const rewritten = Object.fromEntries(rewrittenEntries);

  return rewritten;
}

function resolveWorkspaceFallbackVersion(name, options) {
  if (!options.skipLocalUpstreams) {
    return null;
  }
  return options.fallbackVersions.get(name) ?? null;
}

function normalizeWorkspaceVersion(spec, resolvedVersion) {
  const suffix = spec.slice("workspace:".length);
  if (suffix === "*" || suffix === "^" || suffix === "") {
    return `^${resolvedVersion}`;
  }
  if (suffix === "~") {
    return `~${resolvedVersion}`;
  }
  return suffix;
}

function transformBin(binField, prefix) {
  if (!binField) {
    return undefined;
  }
  if (typeof binField === "string") {
    return transformModulePath(binField, prefix);
  }
  return Object.fromEntries(
    Object.entries(binField).map(([name, value]) => [
      name,
      transformModulePath(value, prefix),
    ]),
  );
}

function transformExports(exportsField, prefix, assetPathPrefix) {
  if (!exportsField) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(exportsField).map(([subpath, target]) => [
      subpath,
      transformExportTarget(target, prefix, assetPathPrefix),
    ]),
  );
}

function transformExportTarget(target, prefix, assetPathPrefix) {
  if (typeof target === "string") {
    if (isAssetPath(target)) {
      return transformAssetPath(target, assetPathPrefix);
    }
    return {
      types: transformTypesPath(target, prefix),
      import: transformModulePath(target, prefix),
      default: transformModulePath(target, prefix),
    };
  }

  if (target && typeof target === "object" && !Array.isArray(target)) {
    return Object.fromEntries(
      Object.entries(target).map(([key, value]) => [
        key,
        typeof value === "string"
          ? isAssetPath(value)
            ? transformAssetPath(value, assetPathPrefix)
            : key === "types"
              ? transformTypesPath(value, prefix)
              : transformModulePath(value, prefix)
          : transformExportTarget(value, prefix, assetPathPrefix),
      ]),
    );
  }

  return target;
}

function transformModulePath(sourcePath, prefix) {
  return withLeadingDot(
    path.posix.join(
      prefix,
      replaceSourceExtension(stripSrcPrefix(sourcePath), ".js"),
    ),
  );
}

function transformTypesPath(sourcePath, prefix) {
  return withLeadingDot(
    path.posix.join(
      prefix,
      replaceSourceExtension(stripSrcPrefix(sourcePath), ".d.ts"),
    ),
  );
}

function transformAssetPath(sourcePath, prefix) {
  return withLeadingDot(path.posix.join(prefix, stripSrcPrefix(sourcePath)));
}

function stripSrcPrefix(sourcePath) {
  return sourcePath
    .replace(/^[.][/]/, "")
    .replace(/^dist\//, "")
    .replace(/^src\//, "");
}

function replaceSourceExtension(relPath, nextExt) {
  const declarationExtMatch = relPath.match(/\.d\.(ts|mts|cts)$/);
  if (declarationExtMatch) {
    return `${relPath.slice(0, -declarationExtMatch[0].length)}${nextExt}`;
  }

  const sourceExtMatch = relPath.match(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/);
  if (sourceExtMatch) {
    return `${relPath.slice(0, -sourceExtMatch[0].length)}${nextExt}`;
  }

  if (relPath.includes("*")) {
    return relPath.endsWith(nextExt) ? relPath : `${relPath}${nextExt}`;
  }

  const ext = path.posix.extname(relPath);
  if (
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".mts" ||
    ext === ".cts" ||
    ext === ".js" ||
    ext === ".jsx" ||
    ext === ".mjs" ||
    ext === ".cjs"
  ) {
    return `${relPath.slice(0, -ext.length)}${nextExt}`;
  }
  if (!ext) {
    return `${relPath}${nextExt}`;
  }
  return relPath;
}

function isAssetPath(sourcePath) {
  return [
    ".css",
    ".json",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
  ].includes(path.posix.extname(sourcePath));
}

function withLeadingDot(relPath) {
  return relPath.startsWith(".") ? relPath : `./${relPath}`;
}

function cleanUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(cleanUndefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, cleanUndefined(entryValue)]),
    );
  }
  return value;
}

function main(argv = process.argv.slice(2)) {
  const [packageDirectory, ...restArgs] = argv;
  if (!packageDirectory) {
    throw new TypeError(
      "usage: node packages/scripts/prepare-package-dist.mjs <package-dir> [--compiled-prefix=path] [--asset-prefix=path]",
    );
  }
  const options = Object.fromEntries(
    restArgs.map((argument) => {
      const match = argument.match(/^--([^=]+)=(.*)$/u);
      if (!match) throw new TypeError(`invalid option: ${argument}`);
      return [match[1], match[2]];
    }),
  );
  preparePackageDist({
    repositoryRoot: repoRoot,
    packageDirectory,
    compiledPrefix: options["compiled-prefix"] ?? "",
    assetPrefix: options["asset-prefix"] ?? "",
    skipLocalUpstreams: process.env.ELIZA_SKIP_LOCAL_UPSTREAMS === "1",
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 the CLI boundary exposes invalid workspace or manifest
    // state to the invoking build instead of emitting a partial dist manifest.
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

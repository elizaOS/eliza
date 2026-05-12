import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const [packageDirArg, ...restArgs] = process.argv.slice(2);

if (!packageDirArg) {
  console.error(
    "usage: node scripts/prepare-package-dist.mjs <package-dir> [--compiled-prefix=path] [--asset-prefix=path]",
  );
  process.exit(1);
}

const options = Object.fromEntries(
  restArgs.map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      console.error(`invalid option: ${arg}`);
      process.exit(1);
    }
    return [match[1], match[2]];
  }),
);

const compiledPrefix = normalizePrefix(options["compiled-prefix"] ?? "");
const assetPrefix = normalizePrefix(options["asset-prefix"] ?? "");
const packageDir = path.resolve(repoRoot, packageDirArg);
const packageJsonPath = path.join(packageDir, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const workspaceVersions = collectWorkspaceVersions(repoRoot);
const skipLocalUpstreams =
  process.env.ELIZA_SKIP_LOCAL_UPSTREAMS === "1" ||
  process.env.ELIZA_SKIP_LOCAL_UPSTREAMS === "1";
const OPTIONAL_PLUGIN_FALLBACK_VERSIONS = new Map([
  ["@elizaos/plugin-sql", "beta"],
  ["@elizaos/plugin-ollama", "beta"],
  ["@elizaos/plugin-local-ai", "beta"],
]);

const publishManifest = {
  ...packageJson,
  main: packageJson.main
    ? transformModulePath(packageJson.main, compiledPrefix)
    : undefined,
  module: packageJson.module
    ? transformModulePath(packageJson.module, compiledPrefix)
    : undefined,
  types: transformTypesPath(getRootEntry(packageJson), compiledPrefix),
  bin: transformBin(packageJson.bin, compiledPrefix),
  exports: transformExports(packageJson.exports, compiledPrefix, assetPrefix),
  dependencies: rewriteWorkspaceDeps(
    packageJson.dependencies,
    workspaceVersions,
  ),
  peerDependencies: rewriteWorkspaceDeps(
    packageJson.peerDependencies,
    workspaceVersions,
  ),
  optionalDependencies: rewriteWorkspaceDeps(
    packageJson.optionalDependencies,
    workspaceVersions,
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

const distDir = path.join(packageDir, "dist");
mkdirSync(distDir, { recursive: true });
writeFileSync(
  path.join(distDir, "package.json"),
  `${JSON.stringify(cleanUndefined(publishManifest), null, 2)}\n`,
);

function collectWorkspaceVersions(rootDir) {
  const packageRoots = [
    path.join(rootDir, "packages"),
    path.join(rootDir, "packages", "native-plugins"),
    path.join(rootDir, "packages", "app-core", "platforms"),
    path.join(rootDir, "plugins"),
    path.join(rootDir, "cloud", "packages"),
  ];
  const versions = new Map();

  for (const packageRoot of packageRoots) {
    walk(packageRoot, (entryPath) => {
      if (path.basename(entryPath) !== "package.json") {
        return;
      }
      const data = JSON.parse(readFileSync(entryPath, "utf8"));
      if (typeof data.name === "string" && typeof data.version === "string") {
        versions.set(data.name, data.version);
      }
    });
  }

  return versions;
}

function walk(dirPath, visit) {
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (
        ["node_modules", "dist", ".git", "android", "ios"].includes(entry.name)
      ) {
        continue;
      }
      walk(entryPath, visit);
      continue;
    }
    visit(entryPath);
  }
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

function rewriteWorkspaceDeps(section, versions) {
  if (!section) {
    return undefined;
  }

  const rewrittenEntries = [];
  for (const [name, version] of Object.entries(section)) {
    if (typeof version === "string" && version.startsWith("workspace:")) {
      const resolvedVersion = versions.get(name);
      if (!resolvedVersion) {
        if (skipLocalUpstreams) {
          const fallbackVersion = resolveWorkspaceFallbackVersion(name);
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

function resolveWorkspaceFallbackVersion(name) {
  if (!skipLocalUpstreams) {
    return null;
  }
  return OPTIONAL_PLUGIN_FALLBACK_VERSIONS.get(name) ?? null;
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

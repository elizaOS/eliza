import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractPlugin, type PluginModuleShape } from "@elizaos/agent";

type PluginCategory =
  | "ai-provider"
  | "connector"
  | "streaming"
  | "database"
  | "app"
  | "feature";

type PluginManifestEntry = {
  id: string;
  dirName: string;
  name: string;
  npmName: string;
  category: PluginCategory;
};

type PluginManifest = {
  plugins: PluginManifestEntry[];
};

type PackageJson = {
  name?: string;
  main?: string;
  module?: string;
  exports?: Record<string, string | Record<string, string>> | string;
  os?: string[];
  agentConfig?: {
    pluginParameters?: Record<string, { required?: boolean }>;
  };
};

export type LocalWorkspacePlugin = {
  id: string;
  dirName: string;
  name: string;
  npmName: string;
  category: Exclude<PluginCategory, "app">;
  packageRoot: string;
  packageJsonPath: string;
  entryPath: string;
  entryUrl: string;
  supportedOs: string[];
  requiredEnvKeys: string[];
};

function findWorkspaceRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, "plugins.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir, "..", "..", "..", "..", "..");
    }
    current = parent;
  }
}

const REPO_ROOT = findWorkspaceRoot(import.meta.dirname);
const PLUGIN_MANIFEST_PATH = path.join(REPO_ROOT, "plugins.json");

let cachedPluginsPromise: Promise<LocalWorkspacePlugin[]> | null = null;

function readPluginManifest(): PluginManifest {
  if (!fs.existsSync(PLUGIN_MANIFEST_PATH)) {
    return { plugins: [] };
  }
  return JSON.parse(
    fs.readFileSync(PLUGIN_MANIFEST_PATH, "utf8"),
  ) as PluginManifest;
}

function findPackageRoot(dirName: string): string | null {
  const candidates = [
    path.join(REPO_ROOT, "plugins", dirName, "typescript"),
    path.join(REPO_ROOT, "plugins", dirName),
    path.join(REPO_ROOT, "packages", dirName),
    path.join(REPO_ROOT, "eliza", "plugins", dirName, "typescript"),
    path.join(REPO_ROOT, "eliza", "plugins", dirName),
    path.join(REPO_ROOT, "eliza", "packages", dirName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return null;
}

function chooseExistingPath(candidates: string[]): string | null {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

function readPackageJson(filePath: string): PackageJson | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

function collectPackageMetadata(packageRoot: string): {
  supportedOs: string[];
  requiredEnvKeys: string[];
} {
  const packageJsonCandidates = [
    path.join(packageRoot, "package.json"),
    path.join(packageRoot, "..", "package.json"),
  ];
  const supportedOs = new Set<string>();
  const requiredEnvKeys = new Set<string>();

  for (const packageJsonPath of packageJsonCandidates) {
    const pkg = readPackageJson(packageJsonPath);
    if (!pkg) {
      continue;
    }

    if (Array.isArray(pkg.os)) {
      for (const target of pkg.os) {
        if (typeof target === "string" && target.length > 0) {
          supportedOs.add(target);
        }
      }
    }

    const params = pkg.agentConfig?.pluginParameters;
    if (params && typeof params === "object") {
      for (const [key, param] of Object.entries(params)) {
        if (param?.required === true) {
          requiredEnvKeys.add(key);
        }
      }
    }
  }

  return {
    supportedOs: [...supportedOs],
    requiredEnvKeys: [...requiredEnvKeys],
  };
}

function resolvePackageEntrySync(packageRoot: string): string | null {
  const fallbackCandidates = [
    path.join(packageRoot, "dist", "node", "index.node.js"),
    path.join(packageRoot, "dist", "index.js"),
    path.join(packageRoot, "dist", "index.mjs"),
    path.join(packageRoot, "dist", "index"),
    path.join(packageRoot, "index.node.ts"),
    path.join(packageRoot, "index.ts"),
    path.join(packageRoot, "src", "index.node.ts"),
    path.join(packageRoot, "src", "index.ts"),
  ];

  try {
    const raw = fs.readFileSync(path.join(packageRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as PackageJson;

    if (typeof pkg.exports === "object" && pkg.exports["."] !== undefined) {
      const rootExport = pkg.exports["."];
      if (typeof rootExport === "string") {
        return chooseExistingPath([
          path.resolve(packageRoot, rootExport),
          ...fallbackCandidates,
        ]);
      }
      const preferred =
        rootExport.node ?? rootExport.import ?? rootExport.default;
      if (typeof preferred === "string") {
        return chooseExistingPath([
          path.resolve(packageRoot, preferred),
          ...fallbackCandidates,
        ]);
      }
      if (preferred && typeof preferred === "object") {
        const nested = preferred.import ?? preferred.default;
        if (typeof nested === "string") {
          return chooseExistingPath([
            path.resolve(packageRoot, nested),
            ...fallbackCandidates,
          ]);
        }
      }
    }

    if (typeof pkg.exports === "string") {
      return chooseExistingPath([
        path.resolve(packageRoot, pkg.exports),
        ...fallbackCandidates,
      ]);
    }
    if (typeof pkg.module === "string") {
      return chooseExistingPath([
        path.resolve(packageRoot, pkg.module),
        ...fallbackCandidates,
      ]);
    }
    if (typeof pkg.main === "string") {
      return chooseExistingPath([
        path.resolve(packageRoot, pkg.main),
        ...fallbackCandidates,
      ]);
    }
  } catch {
    return chooseExistingPath(fallbackCandidates);
  }

  return chooseExistingPath(fallbackCandidates);
}

function normalizePluginNpmName(name: string): string {
  return name.endsWith("-root") ? name.slice(0, -5) : name;
}

function derivePluginId(npmName: string): string | null {
  const normalized = normalizePluginNpmName(npmName);
  if (!normalized.startsWith("@elizaos/plugin-")) {
    return null;
  }

  return normalized.slice("@elizaos/plugin-".length);
}

export async function listLocalWorkspacePlugins(): Promise<
  LocalWorkspacePlugin[]
> {
  cachedPluginsPromise ??= Promise.resolve().then(() => {
    const manifest = readPluginManifest();
    const seen = new Set<string>();
    const localPlugins: LocalWorkspacePlugin[] = [];

    for (const entry of manifest.plugins) {
      if (
        entry.category === "app" ||
        typeof entry.npmName !== "string" ||
        !entry.npmName.includes("/plugin-") ||
        typeof entry.dirName !== "string" ||
        entry.dirName.length === 0
      ) {
        continue;
      }
      if (seen.has(entry.npmName)) {
        continue;
      }

      const packageRoot = findPackageRoot(entry.dirName);
      if (!packageRoot) {
        continue;
      }

      seen.add(entry.npmName);
      const entryPath = resolvePackageEntrySync(packageRoot);
      if (!entryPath) {
        continue;
      }
      const metadata = collectPackageMetadata(packageRoot);
      localPlugins.push({
        id: entry.id,
        dirName: entry.dirName,
        name: entry.name,
        npmName: entry.npmName,
        category: entry.category,
        packageRoot,
        packageJsonPath: path.join(packageRoot, "package.json"),
        entryPath,
        entryUrl: pathToFileURL(entryPath).href,
        supportedOs: metadata.supportedOs,
        requiredEnvKeys: metadata.requiredEnvKeys,
      });
    }

    const pluginsDir = path.join(REPO_ROOT, "eliza", "plugins");
    if (fs.existsSync(pluginsDir)) {
      for (const dirName of fs.readdirSync(pluginsDir).sort()) {
        const rootDir = path.join(pluginsDir, dirName);
        if (!fs.statSync(rootDir).isDirectory()) {
          continue;
        }

        const typescriptRoot = path.join(rootDir, "typescript");
        const typescriptPkg = readPackageJson(
          path.join(typescriptRoot, "package.json"),
        );
        const rootPkg = readPackageJson(path.join(rootDir, "package.json"));
        const rawName =
          typeof typescriptPkg?.name === "string"
            ? typescriptPkg.name
            : typeof rootPkg?.name === "string"
              ? rootPkg.name
              : null;
        if (!rawName) {
          continue;
        }

        const npmName = normalizePluginNpmName(rawName);
        const id = derivePluginId(npmName);
        if (!id || seen.has(npmName)) {
          continue;
        }

        const packageRoot =
          typeof typescriptPkg?.name === "string" ? typescriptRoot : rootDir;
        const entryPath = resolvePackageEntrySync(packageRoot);
        if (!entryPath) {
          continue;
        }

        seen.add(npmName);
        const metadata = collectPackageMetadata(packageRoot);
        localPlugins.push({
          id,
          dirName,
          name: id,
          npmName,
          category: "feature",
          packageRoot,
          packageJsonPath: path.join(packageRoot, "package.json"),
          entryPath,
          entryUrl: pathToFileURL(entryPath).href,
          supportedOs: metadata.supportedOs,
          requiredEnvKeys: metadata.requiredEnvKeys,
        });
      }
    }

    return localPlugins.sort((a, b) => a.id.localeCompare(b.id));
  });

  return cachedPluginsPromise;
}

export async function importLocalWorkspacePlugin(
  plugin: LocalWorkspacePlugin,
): Promise<{
  module: PluginModuleShape;
  extractedPlugin: { name: string } | null;
}> {
  const module = (await import(plugin.entryUrl)) as PluginModuleShape;
  return {
    module,
    extractedPlugin: extractPlugin(module),
  };
}

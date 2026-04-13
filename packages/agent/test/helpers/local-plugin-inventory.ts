import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractPlugin, type PluginModuleShape } from "../../src/test-support/test-helpers.ts";

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
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const PLUGIN_MANIFEST_PATH = path.join(REPO_ROOT, "plugins.json");

let cachedPluginsPromise: Promise<LocalWorkspacePlugin[]> | null = null;

function readPluginManifest(): PluginManifest {
  return JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_PATH, "utf8")) as PluginManifest;
}

function findPackageRoot(dirName: string): string | null {
  const candidates = [
    path.join(REPO_ROOT, "plugins", dirName, "typescript"),
    path.join(REPO_ROOT, "plugins", dirName),
    path.join(REPO_ROOT, "packages", dirName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return null;
}

function chooseExistingPath(candidates: string[]): string {
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
  return path.resolve(candidates[0] ?? "");
}

function resolvePackageEntrySync(packageRoot: string): string {
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
    const pkg = JSON.parse(raw) as {
      main?: string;
      module?: string;
      exports?: Record<string, string | Record<string, string>> | string;
    };

    if (typeof pkg.exports === "object" && pkg.exports["."] !== undefined) {
      const rootExport = pkg.exports["."];
      if (typeof rootExport === "string") {
        return chooseExistingPath([path.resolve(packageRoot, rootExport), ...fallbackCandidates]);
      }
      const preferred = rootExport.node ?? rootExport.import ?? rootExport.default;
      if (typeof preferred === "string") {
        return chooseExistingPath([path.resolve(packageRoot, preferred), ...fallbackCandidates]);
      }
      if (preferred && typeof preferred === "object") {
        const nested = preferred.import ?? preferred.default;
        if (typeof nested === "string") {
          return chooseExistingPath([path.resolve(packageRoot, nested), ...fallbackCandidates]);
        }
      }
    }

    if (typeof pkg.exports === "string") {
      return chooseExistingPath([path.resolve(packageRoot, pkg.exports), ...fallbackCandidates]);
    }
    if (typeof pkg.module === "string") {
      return chooseExistingPath([path.resolve(packageRoot, pkg.module), ...fallbackCandidates]);
    }
    if (typeof pkg.main === "string") {
      return chooseExistingPath([path.resolve(packageRoot, pkg.main), ...fallbackCandidates]);
    }
  } catch {
    return chooseExistingPath(fallbackCandidates);
  }

  return chooseExistingPath(fallbackCandidates);
}

export async function listLocalWorkspacePlugins(): Promise<LocalWorkspacePlugin[]> {
  cachedPluginsPromise ??= Promise.resolve().then(() => {
    const manifest = readPluginManifest();
    const seen = new Set<string>();
    const localPlugins: LocalWorkspacePlugin[] = [];

    for (const entry of manifest.plugins) {
      if (entry.category === "app" || !entry.npmName.includes("/plugin-")) {
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
      });
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

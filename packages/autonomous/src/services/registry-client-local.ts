import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergeAppMeta,
  resolveAppOverride,
} from "./registry-client-app-meta.js";
import type {
  AppUiExtensionConfig,
  RegistryAppMeta,
  RegistryAppViewerMeta,
  RegistryPluginInfo,
} from "./registry-client-types.js";

interface LocalPackageAppMeta {
  displayName?: string;
  category?: string;
  launchType?: string;
  launchUrl?: string | null;
  icon?: string | null;
  capabilities?: string[];
  minPlayers?: number | null;
  maxPlayers?: number | null;
  uiExtension?: AppUiExtensionConfig;
  viewer?: RegistryAppViewerMeta;
}

interface LocalPackageElizaConfig {
  kind?: string;
  app?: LocalPackageAppMeta;
}

interface LocalPackageJson {
  name?: string;
  version?: string;
  description?: string;
  homepage?: string;
  keywords?: string[];
  repository?: string | { type?: string; url?: string };
  elizaos?: LocalPackageElizaConfig;
}

interface LocalPluginManifest {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  homepage?: string;
  tags?: string[];
  repository?: string | { type?: string; url?: string };
  kind?: string;
  app?: LocalPackageAppMeta;
}

const LOCAL_PLUGIN_TAG_STOPWORDS = new Set([
  "plugin",
  "plugins",
  "eliza",
  "elizaos",
  "milady",
  "elizaos-plugin",
  "elizaos-plugins",
  "feature",
]);

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      ordered.push(resolved);
    }
  }
  return ordered;
}

function resolveWorkspaceRoots(): string[] {
  const envRoot = process.env.MILADY_WORKSPACE_ROOT?.trim();
  if (envRoot) return uniquePaths([envRoot]);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, "..", "..");
  const cwd = process.cwd();
  const roots = [
    packageRoot,
    cwd,
    path.resolve(cwd, ".."),
    path.resolve(cwd, "..", ".."),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return uniquePaths(roots);
}

function repoString(
  repo: LocalPackageJson["repository"] | LocalPluginManifest["repository"],
): string | null {
  if (!repo) return null;
  if (typeof repo === "string") return repo;
  if (typeof repo.url === "string" && repo.url.length > 0) return repo.url;
  return null;
}

function normaliseGitHubRepo(repo: string | null): string | null {
  if (!repo) return null;
  const cleaned = repo
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .trim();
  if (!cleaned.includes("/")) return null;
  return cleaned;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeLocalTag(tag: string): string | null {
  const normalized = tag
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized || LOCAL_PLUGIN_TAG_STOPWORDS.has(normalized)) return null;
  return normalized;
}

function normalizeLocalTags(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizeLocalTag(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

function toLocalAppMeta(
  app: LocalPackageAppMeta | undefined,
  fallbackDisplayName: string,
): RegistryAppMeta | undefined {
  if (!app) return undefined;
  const launchType = app.launchType ?? "url";
  return {
    displayName: app.displayName ?? fallbackDisplayName,
    category: app.category ?? "game",
    launchType,
    launchUrl: app.launchUrl ?? null,
    icon: app.icon ?? null,
    capabilities: app.capabilities ?? [],
    minPlayers: app.minPlayers ?? null,
    maxPlayers: app.maxPlayers ?? null,
    uiExtension: app.uiExtension,
    viewer: app.viewer,
  };
}

function toDisplayNameFromDirName(dirName: string): string {
  return dirName
    .replace(/^app-/, "")
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseRepositoryMetadata(
  repository:
    | LocalPackageJson["repository"]
    | LocalPluginManifest["repository"]
    | undefined,
): { gitRepo: string; gitUrl: string } {
  const repoValue = repoString(repository);
  const gitRepo = normaliseGitHubRepo(repoValue) ?? "local/workspace";
  return {
    gitRepo,
    gitUrl: `https://github.com/${gitRepo}.git`,
  };
}

function buildDiscoveredEntry(
  packageDir: string,
  dirName: string,
  packageJson: LocalPackageJson,
  manifest: LocalPluginManifest | null,
): RegistryPluginInfo | null {
  if (!packageJson?.name || packageJson.name.length === 0) return null;

  const packageAppMeta = toLocalAppMeta(
    packageJson.elizaos?.app,
    toDisplayNameFromDirName(dirName),
  );
  const manifestAppMeta = toLocalAppMeta(
    manifest?.app,
    toDisplayNameFromDirName(dirName),
  );
  const mergedMeta = mergeAppMeta(manifestAppMeta, packageAppMeta);
  const overriddenMeta = resolveAppOverride(packageJson.name, mergedMeta);

  const kind =
    packageJson.elizaos?.kind === "app" || manifest?.kind === "app"
      ? "app"
      : overriddenMeta
        ? "app"
        : undefined;

  const repo = parseRepositoryMetadata(
    packageJson.repository ?? manifest?.repository,
  );
  const description = packageJson.description ?? manifest?.description ?? "";
  const topics = normalizeLocalTags([
    ...(packageJson.keywords ?? []),
    ...(manifest?.tags ?? []),
  ]);
  const homepage =
    packageJson.homepage ??
    manifest?.homepage ??
    overriddenMeta?.launchUrl ??
    null;
  const version = packageJson.version ?? manifest?.version ?? null;

  return {
    name: packageJson.name,
    gitRepo: repo.gitRepo,
    gitUrl: repo.gitUrl,
    description,
    homepage,
    topics,
    stars: 0,
    language: "TypeScript",
    npm: {
      package: packageJson.name,
      v0Version: null,
      v1Version: null,
      v2Version: version,
    },
    git: {
      v0Branch: null,
      v1Branch: null,
      v2Branch: "main",
    },
    supports: { v0: false, v1: false, v2: true },
    localPath: packageDir,
    kind,
    appMeta: overriddenMeta ?? undefined,
  };
}

async function discoverLocalWorkspaceApps(): Promise<
  Map<string, RegistryPluginInfo>
> {
  const discovered = new Map<string, RegistryPluginInfo>();

  for (const workspaceRoot of resolveWorkspaceRoots()) {
    const pluginsDir = path.join(workspaceRoot, "plugins");
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(pluginsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (
        (!entry.isDirectory() && !entry.isSymbolicLink()) ||
        !entry.name.startsWith("app-")
      )
        continue;
      const packageDir = path.join(pluginsDir, entry.name);
      const packageJson = await readJsonFile<LocalPackageJson>(
        path.join(packageDir, "package.json"),
      );
      if (!packageJson) continue;

      const manifest = await readJsonFile<LocalPluginManifest>(
        path.join(packageDir, "elizaos.plugin.json"),
      );
      const info = buildDiscoveredEntry(
        packageDir,
        entry.name,
        packageJson,
        manifest,
      );
      if (info) discovered.set(info.name, info);
    }
  }

  const stateDir =
    process.env.MILADY_STATE_DIR?.trim() || path.join(os.homedir(), ".milady");
  const installedBase = path.join(stateDir, "plugins", "installed");
  try {
    const installedEntries = await fs.readdir(installedBase, {
      withFileTypes: true,
    });
    for (const entry of installedEntries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const installDir = path.join(installedBase, entry.name);
      const nmDir = path.join(installDir, "node_modules");
      const pkgDirs: string[] = [];
      try {
        const nmEntries = await fs.readdir(nmDir, { withFileTypes: true });
        for (const nm of nmEntries) {
          if (nm.name.startsWith("@")) {
            const scopeDir = path.join(nmDir, nm.name);
            try {
              const scopeEntries = await fs.readdir(scopeDir, {
                withFileTypes: true,
              });
              for (const se of scopeEntries) {
                pkgDirs.push(path.join(scopeDir, se.name));
              }
            } catch {
              // skip
            }
          } else if (nm.isDirectory() || nm.isSymbolicLink()) {
            pkgDirs.push(path.join(nmDir, nm.name));
          }
        }
      } catch {
        continue;
      }

      for (const pkgDir of pkgDirs) {
        const pkgJson = await readJsonFile<LocalPackageJson>(
          path.join(pkgDir, "package.json"),
        );
        if (!pkgJson?.name) continue;
        if (pkgJson.elizaos?.kind !== "app") continue;
        if (discovered.has(pkgJson.name)) continue;

        const manifest = await readJsonFile<LocalPluginManifest>(
          path.join(pkgDir, "elizaos.plugin.json"),
        );
        const dirName = pkgJson.name
          .replace(/^@[^/]+\//, "")
          .replace(/^plugin-/, "app-");
        const info = buildDiscoveredEntry(pkgDir, dirName, pkgJson, manifest);
        if (info) discovered.set(info.name, info);
      }
    }
  } catch {
    // installed dir may not exist
  }

  return discovered;
}

async function discoverNodeModulePlugins(): Promise<
  Map<string, RegistryPluginInfo>
> {
  const discovered = new Map<string, RegistryPluginInfo>();

  for (const workspaceRoot of resolveWorkspaceRoots()) {
    const elizaosDir = path.join(workspaceRoot, "node_modules", "@elizaos");
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(elizaosDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.name.startsWith("plugin-")) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const packageDir = path.join(elizaosDir, entry.name);
      const packageJson = await readJsonFile<
        LocalPackageJson & {
          packageType?: string;
          keywords?: string[];
          agentConfig?: Record<string, unknown>;
        }
      >(path.join(packageDir, "package.json"));
      if (!packageJson?.name) continue;

      const isPlugin =
        packageJson.packageType === "plugin" ||
        packageJson.keywords?.includes("elizaos") ||
        packageJson.elizaos !== undefined ||
        packageJson.agentConfig !== undefined;
      if (!isPlugin) continue;

      if (packageJson.elizaos?.kind === "app") continue;

      const repo = parseRepositoryMetadata(packageJson.repository);
      const version = packageJson.version ?? null;

      let localPath = packageDir;
      try {
        const realPath = await fs.realpath(packageDir);
        if (realPath !== packageDir) localPath = realPath;
      } catch {
        // fallback
      }

      discovered.set(packageJson.name, {
        name: packageJson.name,
        gitRepo: repo.gitRepo,
        gitUrl: repo.gitUrl,
        description: packageJson.description ?? "",
        homepage: packageJson.homepage ?? null,
        topics: normalizeLocalTags(packageJson.keywords),
        stars: 0,
        language: "TypeScript",
        npm: {
          package: packageJson.name,
          v0Version: null,
          v1Version: null,
          v2Version: version,
        },
        git: {
          v0Branch: null,
          v1Branch: null,
          v2Branch: "main",
        },
        supports: { v0: false, v1: false, v2: true },
        localPath,
      });
    }
  }

  return discovered;
}

export async function applyNodeModulePlugins(
  plugins: Map<string, RegistryPluginInfo>,
): Promise<void> {
  const localPlugins = await discoverNodeModulePlugins();
  if (localPlugins.size === 0) return;

  for (const [name, localInfo] of localPlugins.entries()) {
    const existing = plugins.get(name);
    if (!existing) {
      plugins.set(name, localInfo);
    } else if (!existing.localPath) {
      plugins.set(name, { ...existing, localPath: localInfo.localPath });
    }
  }
}

export async function applyLocalWorkspaceApps(
  plugins: Map<string, RegistryPluginInfo>,
): Promise<void> {
  const localApps = await discoverLocalWorkspaceApps();
  if (localApps.size === 0) return;

  for (const [name, localInfo] of localApps.entries()) {
    const existing = plugins.get(name);
    if (!existing) {
      plugins.set(name, localInfo);
      continue;
    }

    plugins.set(name, {
      ...existing,
      localPath: localInfo.localPath,
      kind: localInfo.kind ?? existing.kind,
      appMeta: mergeAppMeta(existing.appMeta, localInfo.appMeta),
      description: localInfo.description || existing.description,
      homepage: localInfo.homepage ?? existing.homepage,
      npm: {
        ...existing.npm,
        package: existing.npm.package || localInfo.npm.package,
        v2Version: existing.npm.v2Version ?? localInfo.npm.v2Version,
      },
      git: {
        v0Branch: existing.git.v0Branch ?? localInfo.git.v0Branch,
        v1Branch: existing.git.v1Branch ?? localInfo.git.v1Branch,
        v2Branch: existing.git.v2Branch ?? localInfo.git.v2Branch,
      },
    });
  }
}

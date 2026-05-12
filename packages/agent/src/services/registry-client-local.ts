import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";
import { packageNameToAppDisplayName } from "@elizaos/shared";
import { resolveStateDir } from "../config/paths.ts";
import { readJsonFile } from "../utils/atomic-json.ts";
import {
  mergeAppMeta,
  resolveAppOverride,
} from "./registry-client-app-meta.ts";
import type {
  AppUiExtensionConfig,
  RegistryAppMeta,
  RegistryAppSessionMeta,
  RegistryAppViewerMeta,
  RegistryPluginInfo,
} from "./registry-client-types.ts";

interface LocalPackageAppMeta {
  displayName?: string;
  category?: string;
  launchType?: string;
  launchUrl?: string | null;
  icon?: string | null;
  /**
   * Package-relative path (e.g. `"assets/hero.png"`) or absolute URL to
   * a full-card hero image. The registry resolves relative paths to a
   * served URL (`/api/apps/hero/<slug>`) so clients get a plain URL.
   */
  heroImage?: string | null;
  capabilities?: string[];
  minPlayers?: number | null;
  maxPlayers?: number | null;
  runtimePlugin?: string;
  bridgeExport?: string;
  uiExtension?: AppUiExtensionConfig;
  viewer?: RegistryAppViewerMeta;
  session?: RegistryAppSessionMeta;
  developerOnly?: boolean;
  visibleInAppStore?: boolean;
  /**
   * If true, this app declares itself as the default landing tab for the
   * shell. Exactly one installed app should set this; if multiple do, the
   * shell picks the first one alphabetically by package name and logs a
   * warning. Used by `getMainTabApp()` in app-core to compute the
   * landing tab at boot.
   */
  mainTab?: boolean;
}

interface LocalPackageElizaConfig {
  kind?: string;
  app?: LocalPackageAppMeta;
  viewer?: RegistryAppViewerMeta;
  session?: RegistryAppSessionMeta;
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
  viewer?: RegistryAppViewerMeta;
  session?: RegistryAppSessionMeta;
}

const LOCAL_PLUGIN_TAG_STOPWORDS = new Set([
  "plugin",
  "plugins",
  "eliza",
  "elizaos",
  "eliza",
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
  const envRoot = process.env.ELIZA_WORKSPACE_ROOT?.trim();
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

  // Monorepos (e.g. Eliza) hoist `@elizaos/*` under the repo root, while this
  // module lives in `packages/agent`. When the process cwd is deep (`apps/...`,
  // Electrobun bundle, etc.), cwd-based roots never reach that `node_modules`.
  // Walk up from the agent package so `getPluginInfo` can resolve vendored
  // workspace plugins for install.
  let walk = path.resolve(packageRoot);
  for (let depth = 0; depth < 8; depth += 1) {
    roots.push(walk);
    const parent = path.dirname(walk);
    if (parent === walk) break;
    walk = parent;
  }

  return uniquePaths(roots);
}

function legacyAppsWorkspaceDiscoveryEnabled(): boolean {
  const raw = process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isMissingPathError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    "code" in err &&
    (((err as NodeJS.ErrnoException).code ?? "") === "ENOENT" ||
      ((err as NodeJS.ErrnoException).code ?? "") === "ENOTDIR")
  );
}

async function readDirectoryEntries(
  dirPath: string,
  label: string,
  options: {
    suppressMissing?: boolean;
  } = {},
): Promise<Array<import("node:fs").Dirent>> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if (!(options.suppressMissing && isMissingPathError(err))) {
      logger.debug(`[registry] could not read ${label} ${dirPath}: ${err}`);
    }
    return [];
  }
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
  legacy?: {
    viewer?: RegistryAppViewerMeta;
    session?: RegistryAppSessionMeta;
  },
): RegistryAppMeta | undefined {
  if (!app && !legacy?.viewer && !legacy?.session) return undefined;
  const launchType =
    app?.launchType ?? (legacy?.viewer || legacy?.session ? "connect" : "url");
  return {
    displayName: app?.displayName ?? fallbackDisplayName,
    category: app?.category ?? "game",
    launchType,
    launchUrl: app?.launchUrl ?? null,
    icon: app?.icon ?? null,
    heroImage: app?.heroImage ?? null,
    capabilities: app?.capabilities ?? [],
    minPlayers: app?.minPlayers ?? null,
    maxPlayers: app?.maxPlayers ?? null,
    runtimePlugin: app?.runtimePlugin,
    bridgeExport: app?.bridgeExport,
    uiExtension: app?.uiExtension,
    viewer: app?.viewer ?? legacy?.viewer,
    session: app?.session ?? legacy?.session,
    developerOnly: app?.developerOnly,
    visibleInAppStore: app?.visibleInAppStore,
    mainTab: app?.mainTab,
  };
}

function toDisplayNameFromDirName(dirName: string): string {
  return packageNameToAppDisplayName(dirName);
}

function isDiscoverableAppPackage(
  packageJson: LocalPackageJson,
  manifest: LocalPluginManifest | null,
): boolean {
  if (!packageJson.name) return false;

  return Boolean(
    packageJson.elizaos?.kind === "app" ||
      manifest?.kind === "app" ||
      packageJson.elizaos?.app ||
      packageJson.elizaos?.viewer ||
      packageJson.elizaos?.session ||
      manifest?.app ||
      manifest?.viewer ||
      manifest?.session ||
      resolveAppOverride(packageJson.name, undefined),
  );
}

async function collectWorkspacePackageCandidates(
  searchRoot: string,
  includeTypescriptChild = false,
): Promise<Array<{ packageDir: string; dirName: string }>> {
  const candidates = new Map<string, { packageDir: string; dirName: string }>();
  const entries = await readDirectoryEntries(searchRoot, "workspace dir", {
    suppressMissing: true,
  });

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const repoDir = path.join(searchRoot, entry.name);
    candidates.set(repoDir, {
      packageDir: repoDir,
      dirName: entry.name,
    });

    if (!includeTypescriptChild) continue;

    const typescriptDir = path.join(repoDir, "typescript");
    candidates.set(typescriptDir, {
      packageDir: typescriptDir,
      dirName: entry.name,
    });
  }

  return [...candidates.values()];
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
    {
      viewer: packageJson.elizaos?.viewer,
      session: packageJson.elizaos?.session,
    },
  );
  const manifestAppMeta = toLocalAppMeta(
    manifest?.app,
    toDisplayNameFromDirName(dirName),
    {
      viewer: manifest?.viewer,
      session: manifest?.session,
    },
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
  const packageCandidates = new Map<
    string,
    { packageDir: string; dirName: string }
  >();

  for (const workspaceRoot of resolveWorkspaceRoots()) {
    const discoveredRoots = new Map<string, boolean>();
    const addDiscoveredRoot = (
      root: string,
      includeTypescriptChild: boolean,
    ): void => {
      const resolvedRoot = path.resolve(root);
      discoveredRoots.set(
        resolvedRoot,
        (discoveredRoots.get(resolvedRoot) ?? false) || includeTypescriptChild,
      );
    };

    addDiscoveredRoot(path.join(workspaceRoot, "plugins"), true);
    addDiscoveredRoot(path.join(workspaceRoot, "packages"), false);
    addDiscoveredRoot(path.join(workspaceRoot, "eliza", "packages"), false);
    addDiscoveredRoot(path.join(workspaceRoot, "eliza", "plugins"), true);
    if (legacyAppsWorkspaceDiscoveryEnabled()) {
      // Temporary opt-in for older external workspaces that still keep app
      // plugins under apps/app-*. The current repo discovers plugins/app-* by
      // default and must not depend on top-level apps/*.
      addDiscoveredRoot(path.join(workspaceRoot, "apps"), false);
      addDiscoveredRoot(path.join(workspaceRoot, "eliza", "apps"), false);
    }

    const workspaceEntries = await readDirectoryEntries(
      workspaceRoot,
      "workspace root",
    );

    for (const entry of workspaceEntries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const repoRoot = path.join(workspaceRoot, entry.name);
      addDiscoveredRoot(path.join(repoRoot, "plugins"), true);
      addDiscoveredRoot(path.join(repoRoot, "packages"), false);
      addDiscoveredRoot(path.join(repoRoot, "eliza", "packages"), false);
      addDiscoveredRoot(path.join(repoRoot, "eliza", "plugins"), true);
      if (legacyAppsWorkspaceDiscoveryEnabled()) {
        addDiscoveredRoot(path.join(repoRoot, "apps"), false);
        addDiscoveredRoot(path.join(repoRoot, "eliza", "apps"), false);
      }
    }

    for (const [root, includeTypescriptChild] of discoveredRoots) {
      const candidates = await collectWorkspacePackageCandidates(
        root,
        includeTypescriptChild,
      );
      for (const candidate of candidates) {
        packageCandidates.set(candidate.packageDir, candidate);
      }
    }
  }

  for (const { packageDir, dirName } of packageCandidates.values()) {
    const packageJson = await readJsonFile<LocalPackageJson>(
      path.join(packageDir, "package.json"),
    );
    if (!packageJson) continue;

    const manifest = await readJsonFile<LocalPluginManifest>(
      path.join(packageDir, "elizaos.plugin.json"),
    );
    if (!isDiscoverableAppPackage(packageJson, manifest)) continue;

    const info = buildDiscoveredEntry(
      packageDir,
      dirName,
      packageJson,
      manifest,
    );
    if (info && !discovered.has(info.name)) {
      discovered.set(info.name, info);
    }
  }

  const stateDir = resolveStateDir();
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
            } catch (err) {
              logger.debug(
                `[registry] could not read scope dir ${scopeDir}: ${err}`,
              );
            }
          } else if (nm.isDirectory() || nm.isSymbolicLink()) {
            pkgDirs.push(path.join(nmDir, nm.name));
          }
        }
      } catch (err) {
        logger.debug(
          `[registry] could not read node_modules dir ${nmDir}: ${err}`,
        );
        continue;
      }

      for (const pkgDir of pkgDirs) {
        const pkgJson = await readJsonFile<LocalPackageJson>(
          path.join(pkgDir, "package.json"),
        );
        if (!pkgJson?.name) continue;
        const manifest = await readJsonFile<LocalPluginManifest>(
          path.join(pkgDir, "elizaos.plugin.json"),
        );
        if (!isDiscoverableAppPackage(pkgJson, manifest)) continue;
        if (discovered.has(pkgJson.name)) continue;

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
    const entries = await readDirectoryEntries(elizaosDir, "@elizaos dir", {
      suppressMissing: true,
    });

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

/** Workspace-vendored `packages/plugin-*` trees (not always linked under root node_modules). */
async function discoverPackagesFolderPlugins(): Promise<
  Map<string, RegistryPluginInfo>
> {
  const discovered = new Map<string, RegistryPluginInfo>();

  for (const workspaceRoot of resolveWorkspaceRoots()) {
    const packagesDir = path.join(workspaceRoot, "packages");
    const entries = await readDirectoryEntries(packagesDir, "packages dir", {
      suppressMissing: true,
    });

    for (const entry of entries) {
      if (!entry.name.startsWith("plugin-")) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const packageDir = path.join(packagesDir, entry.name);
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
      if (!packageJson.name.startsWith("@elizaos/plugin-")) continue;

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
  const packagesPlugins = await discoverPackagesFolderPlugins();

  for (const [name, info] of packagesPlugins) {
    if (!localPlugins.has(name)) {
      localPlugins.set(name, info);
    } else {
      const existing = localPlugins.get(name);
      if (existing && !existing.localPath && info.localPath) {
        localPlugins.set(name, { ...existing, localPath: info.localPath });
      }
    }
  }

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

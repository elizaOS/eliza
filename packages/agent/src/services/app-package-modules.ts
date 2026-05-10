import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "@elizaos/core";
import { logger, resolveStateDir } from "@elizaos/core";
import {
  type AppLaunchDiagnostic,
  type AppLaunchPreparation,
  type AppLaunchSessionContext,
  type AppRunSessionContext,
  type AppSessionState,
  type AppViewerAuthMessage,
  hasAppInterface,
  packageNameToAppRouteSlug,
} from "@elizaos/shared";
import { readJsonFile } from "../utils/atomic-json.ts";
import { getPluginInfo } from "./registry-client.ts";

export type {
  AppLaunchSessionContext,
  AppRunSessionContext,
} from "@elizaos/shared";

export type AppLaunchPreparationResolver = (
  ctx: AppLaunchSessionContext,
) => Promise<AppLaunchPreparation | null>;

export type AppViewerAuthMessageResolver = (
  ctx: AppLaunchSessionContext,
) => Promise<AppViewerAuthMessage | null>;

export type AppLaunchSessionResolver = (
  ctx: AppLaunchSessionContext,
) => Promise<AppSessionState | null>;

export type AppRunSessionRefresher = (
  ctx: AppRunSessionContext,
) => Promise<AppSessionState | null>;

export type AppRouteModule = {
  handleAppRoutes?: (ctx: unknown) => Promise<boolean>;
  prepareLaunch?: AppLaunchPreparationResolver;
  resolveViewerAuthMessage?: AppViewerAuthMessageResolver;
  ensureRuntimeReady?: (ctx: AppLaunchSessionContext) => Promise<void>;
  collectLaunchDiagnostics?: (
    ctx: AppRunSessionContext,
  ) => Promise<AppLaunchDiagnostic[]>;
  resolveLaunchSession?: AppLaunchSessionResolver;
  refreshRunSession?: AppRunSessionRefresher;
  [key: string]: unknown;
};

type AppPluginWithBridge = Plugin & {
  appBridge?: AppRouteModule;
};

type AppPluginModule = {
  default?: AppPluginWithBridge;
  [key: string]: unknown;
};

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      ordered.push(resolved);
    }
  }
  return ordered;
}

function resolveWorkspaceRoots(): string[] {
  const envRoot = process.env.ELIZA_WORKSPACE_ROOT?.trim();
  if (envRoot) {
    return uniquePaths([envRoot]);
  }

  const cwd = process.cwd();
  return uniquePaths([
    cwd,
    path.resolve(cwd, ".."),
    path.resolve(cwd, "..", ".."),
  ]);
}

function legacyAppsWorkspaceDiscoveryEnabled(): boolean {
  const raw = process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function packageNameToDirName(packageName: string): string {
  return packageName.replace(/^@[^/]+\//, "");
}

function sanitiseInstalledPackageDirName(packageName: string): string {
  return packageName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Directory where the plugin-installer writes dynamically-installed plugins.
 * Matches `packages/app-core/src/services/plugin-installer.ts::pluginsBaseDir`.
 */
function installedPluginsBaseDir(): string {
  return path.join(resolveStateDir(), "plugins", "installed");
}

/**
 * Path to a dynamically-installed plugin's actual package directory (inside
 * `node_modules` under the install target). Returns null if not installed.
 */
function resolveInstalledPluginDir(packageName: string): string | null {
  const installRoot = path.join(
    installedPluginsBaseDir(),
    sanitiseInstalledPackageDirName(packageName),
    "node_modules",
    ...packageName.split("/"),
  );
  return fs.existsSync(path.join(installRoot, "package.json"))
    ? installRoot
    : null;
}

async function readPackageName(packageDir: string): Promise<string | null> {
  try {
    const packageJson = JSON.parse(
      await fs.promises.readFile(path.join(packageDir, "package.json"), "utf8"),
    ) as { name?: unknown };
    return typeof packageJson.name === "string" ? packageJson.name : null;
  } catch {
    return null;
  }
}

async function resolveWorkspacePackageDirs(
  packageName: string,
): Promise<string[]> {
  const dirName = packageNameToDirName(packageName);
  const candidateDirs: string[] = [];

  for (const workspaceRoot of resolveWorkspaceRoots()) {
    candidateDirs.push(
      path.join(workspaceRoot, "plugins", dirName),
      path.join(workspaceRoot, "packages", dirName),
    );
    if (legacyAppsWorkspaceDiscoveryEnabled()) {
      // Temporary opt-in for older external workspaces. Current Eliza app
      // plugins live under plugins/app-* and keep @elizaos/app-* names.
      candidateDirs.push(path.join(workspaceRoot, "apps", dirName));
    }

    let rootEntries: fs.Dirent[] = [];
    try {
      rootEntries = await fs.promises.readdir(workspaceRoot, {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    for (const entry of rootEntries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      candidateDirs.push(
        path.join(workspaceRoot, entry.name, "plugins", dirName),
        path.join(workspaceRoot, entry.name, "packages", dirName),
      );
      if (legacyAppsWorkspaceDiscoveryEnabled()) {
        candidateDirs.push(
          path.join(workspaceRoot, entry.name, "apps", dirName),
        );
      }
    }
  }

  const matches: string[] = [];
  for (const candidateDir of uniquePaths(candidateDirs)) {
    if (!fs.existsSync(path.join(candidateDir, "package.json"))) {
      continue;
    }
    const discoveredName = await readPackageName(candidateDir);
    if (discoveredName === packageName) {
      matches.push(candidateDir);
    }
  }

  return matches;
}

export async function resolveWorkspacePackageDir(
  packageName: string,
): Promise<string | null> {
  const matches = await resolveWorkspacePackageDirs(packageName);
  return matches[0] ?? null;
}

async function importFirstExistingModule<T>(
  candidatePaths: string[],
): Promise<T | null> {
  let lastError: unknown = null;

  for (const candidatePath of candidatePaths) {
    if (!fs.existsSync(candidatePath)) continue;
    try {
      return (await import(pathToFileURL(candidatePath).href)) as T;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

export function packageNameToAppSlug(packageName: string): string | null {
  return packageNameToAppRouteSlug(packageName);
}

interface ResolvedAppModuleTarget {
  packageName: string | null;
  localPath: string | null;
  bridgeExport: string | null;
}

interface LocalPackageJson {
  elizaos?: {
    app?: {
      bridgeExport?: unknown;
    };
  };
}

interface LocalPluginManifest {
  app?: {
    bridgeExport?: unknown;
  };
}

async function readLocalBridgeExport(
  packageDir: string,
): Promise<string | null> {
  const packageJson = await readJsonFile<LocalPackageJson>(
    path.join(packageDir, "package.json"),
  );
  const manifest = await readJsonFile<LocalPluginManifest>(
    path.join(packageDir, "elizaos.plugin.json"),
  );
  const packageBridgeExport = packageJson?.elizaos?.app?.bridgeExport;
  if (typeof packageBridgeExport === "string") {
    return packageBridgeExport;
  }
  const manifestBridgeExport = manifest?.app?.bridgeExport;
  return typeof manifestBridgeExport === "string" ? manifestBridgeExport : null;
}

async function resolveAppModuleTarget(
  appIdentifier: string,
): Promise<ResolvedAppModuleTarget | null> {
  const trimmed = appIdentifier.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("@")) {
    const registryInfo = await getPluginInfo(trimmed);
    if (
      registryInfo &&
      (hasAppInterface(registryInfo) || registryInfo.localPath)
    ) {
      return {
        packageName: registryInfo.name,
        localPath: registryInfo.localPath ?? null,
        bridgeExport: registryInfo.appMeta?.bridgeExport ?? null,
      };
    }
  }

  const packageCandidates = trimmed.startsWith("@")
    ? [trimmed]
    : [`@elizaos/app-${trimmed}`, `@elizaos/plugin-${trimmed}`];

  for (const packageName of packageCandidates) {
    const localPath = await resolveWorkspacePackageDir(packageName);
    if (localPath) {
      return {
        packageName,
        localPath,
        bridgeExport: await readLocalBridgeExport(localPath),
      };
    }
  }

  const registryInfo = await getPluginInfo(trimmed);
  if (
    registryInfo &&
    (hasAppInterface(registryInfo) || registryInfo.localPath)
  ) {
    return {
      packageName: registryInfo.name,
      localPath: registryInfo.localPath ?? null,
      bridgeExport: registryInfo.appMeta?.bridgeExport ?? null,
    };
  }

  return {
    packageName: trimmed.startsWith("@") ? trimmed : null,
    localPath: null,
    bridgeExport: null,
  };
}

function normalizeBridgeExport(bridgeExport: string | null): string | null {
  if (!bridgeExport) return null;
  const trimmed = bridgeExport.trim();
  if (!trimmed.startsWith("./") || trimmed.length <= 2) {
    return null;
  }
  return trimmed;
}

function buildLocalBridgeCandidates(
  localPath: string,
  bridgeExport: string | null,
): string[] {
  const normalized = normalizeBridgeExport(bridgeExport);
  if (!normalized) {
    return [];
  }

  const relativePath = normalized.slice(2);
  const hasExtension = /\.[cm]?[jt]s$/.test(relativePath);
  const candidates = new Set<string>();

  const add = (candidate: string) => {
    candidates.add(path.join(localPath, candidate));
  };

  if (hasExtension) {
    add(relativePath);
    add(path.join("src", relativePath));
    add(path.join("dist", relativePath.replace(/\.ts$/, ".js")));
  } else {
    add(`${relativePath}.ts`);
    add(`${relativePath}.js`);
    add(path.join("src", `${relativePath}.ts`));
    add(path.join("src", `${relativePath}.js`));
    add(path.join("dist", `${relativePath}.js`));
  }

  return [...candidates];
}

function bridgeExportToSpecifier(
  packageName: string,
  bridgeExport: string | null,
): string | null {
  const normalized = normalizeBridgeExport(bridgeExport);
  if (!normalized) {
    return null;
  }
  return `${packageName}/${normalized.slice(2)}`;
}

async function importLocalAppRouteModule(
  appIdentifier: string,
): Promise<AppRouteModule | null> {
  const resolved = await resolveAppModuleTarget(appIdentifier);
  const localPath = resolved?.localPath ?? null;
  if (!localPath) return null;

  const candidatePaths = [
    ...buildLocalBridgeCandidates(localPath, resolved?.bridgeExport ?? null),
    path.join(localPath, "src", "app.ts"),
    path.join(localPath, "src", "app.js"),
    path.join(localPath, "dist", "app.js"),
    path.join(localPath, "src", "routes.ts"),
    path.join(localPath, "src", "routes.js"),
    path.join(localPath, "dist", "routes.js"),
  ];
  return importFirstExistingModule<AppRouteModule>(candidatePaths);
}

async function importLocalAppPluginModule(
  packageName: string,
): Promise<AppPluginModule | null> {
  const resolved = await resolveAppModuleTarget(packageName);
  const localPaths: string[] = [];
  if (resolved?.localPath) {
    localPaths.push(resolved.localPath);
  }
  for (const dir of await resolveWorkspacePackageDirs(packageName)) {
    if (!localPaths.includes(dir)) {
      localPaths.push(dir);
    }
  }
  const installedDir = resolveInstalledPluginDir(packageName);
  if (installedDir && !localPaths.includes(installedDir)) {
    localPaths.push(installedDir);
  }
  if (localPaths.length === 0) return null;

  let firstModule: AppPluginModule | null = null;
  let lastError: unknown = null;
  for (const localPath of localPaths) {
    const candidatePaths = [
      path.join(localPath, "src", "index.ts"),
      path.join(localPath, "src", "index.js"),
      path.join(localPath, "dist", "index.js"),
    ];
    let mod: AppPluginModule | null = null;
    try {
      mod = await importFirstExistingModule<AppPluginModule>(candidatePaths);
    } catch (err) {
      lastError = err;
      logger.warn(
        `[app-package-modules] Failed to import plugin from ${localPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (!mod) continue;
    if (firstModule === null) {
      firstModule = mod;
    }
    if (resolvePluginExport(mod, packageName)) {
      return mod;
    }
  }
  if (firstModule) {
    return firstModule;
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

function isPluginLike(value: unknown): value is Plugin {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

function resolvePluginExport(
  module: AppPluginModule,
  packageName: string,
): Plugin | null {
  if (isPluginLike(module.default)) {
    return module.default;
  }

  for (const value of Object.values(module)) {
    if (isPluginLike(value) && value.name === packageName) {
      return value;
    }
  }

  return null;
}

function resolvePluginAppBridge(plugin: Plugin | null): AppRouteModule | null {
  if (!plugin || typeof plugin !== "object") {
    return null;
  }

  const bridge = (plugin as AppPluginWithBridge).appBridge;
  if (!bridge || typeof bridge !== "object") {
    return null;
  }

  return bridge;
}

export async function importAppRouteModule(
  appIdentifier: string,
): Promise<AppRouteModule | null> {
  const resolved = await resolveAppModuleTarget(appIdentifier);
  const packageName = resolved?.packageName ?? null;
  const label = packageName ?? appIdentifier;

  try {
    // Prefer workspace-local route modules before built-ins so checked-out app
    // plugins can intentionally override the packaged bridge during local
    // development. This lookup is repo/workspace-scoped rather than install-
    // directory scoped, so accidental shadowing stays limited to active dev
    // workspaces.
    const localModule = await importLocalAppRouteModule(appIdentifier);
    if (localModule) {
      return localModule;
    }
  } catch (err) {
    logger.warn(
      `[app-package-modules] Failed to import local routes for ${label}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!packageName) {
    return null;
  }

  const bridgeSpecifier = bridgeExportToSpecifier(
    packageName,
    resolved?.bridgeExport ?? null,
  );

  if (bridgeSpecifier) {
    try {
      return (await import(
        /* webpackIgnore: true */ bridgeSpecifier
      )) as AppRouteModule;
    } catch {
      // Fall through to canonical app/routes entrypoints.
    }
  }

  try {
    return (await import(
      /* webpackIgnore: true */ `${packageName}/app`
    )) as AppRouteModule;
  } catch {
    // Fall through to legacy routes entrypoint / plugin export bridge.
  }

  try {
    return (await import(
      /* webpackIgnore: true */ `${packageName}/routes`
    )) as AppRouteModule;
  } catch {
    const plugin = await importAppPlugin(packageName);
    return resolvePluginAppBridge(plugin);
  }
}

export async function importAppPlugin(
  packageName: string,
): Promise<Plugin | null> {
  try {
    const localModule = await importLocalAppPluginModule(packageName);
    if (localModule) {
      return resolvePluginExport(localModule, packageName);
    }
  } catch (err) {
    logger.warn(
      `[app-package-modules] Failed to import local plugin for ${packageName}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  try {
    const packageModule = (await import(
      /* webpackIgnore: true */ packageName
    )) as AppPluginModule;
    return resolvePluginExport(packageModule, packageName);
  } catch {
    return null;
  }
}

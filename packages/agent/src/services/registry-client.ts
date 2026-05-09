/**
 * Registry Client for Eliza.
 *
 * Provides a 3-tier cached registry (memory → file → network) that works
 * offline, in .app bundles, and in dev. Fetches from the next branch.
 *
 * @module services/registry-client
 */

import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "@elizaos/core";
import { loadElizaConfig, saveElizaConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { RegistryEndpoint } from "../config/types.eliza.js";
import {
  LOCAL_APP_DEFAULT_SANDBOX,
  resolveAppOverride,
  sanitizeSandbox,
} from "./registry-client-app-meta.js";
import {
  isDefaultEndpoint as isDefaultEndpointForUrl,
  mergeCustomEndpoints,
  normaliseEndpointUrl,
  parseRegistryEndpointUrl,
} from "./registry-client-endpoints.js";
import {
  applyLocalWorkspaceApps,
  applyNodeModulePlugins,
} from "./registry-client-local.js";
import {
  fetchFromNetwork as fetchRegistryFromNetwork,
  isExpectedRegistryNetworkFallback,
} from "./registry-client-network.js";
import {
  getPluginInfoFromRegistry,
  normalizePluginLookupAlias,
  scoreEntries,
  toAppEntry,
  toAppInfo,
  toPluginListItem,
  toSearchResults,
} from "./registry-client-queries.js";
import type {
  RegistryAppInfo,
  RegistryPluginInfo,
  RegistryPluginListItem,
  RegistrySearchResult,
} from "./registry-client-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERATED_REGISTRY_URL =
  "https://raw.githubusercontent.com/elizaos-plugins/registry/next/generated-registry.json";
const INDEX_REGISTRY_URL =
  "https://raw.githubusercontent.com/elizaos-plugins/registry/next/index.json";
const CACHE_TTL_MS = 3_600_000; // 1 hour
const BLOCKED_REGISTRY_PLUGIN_NAMES = new Set([
  "@elizaos/app-agent-town",
  "@elizaos/app-dungeons",
  "@elizaos/app-dungeons-and-daemons",
]);
const BLOCKED_REGISTRY_PLUGIN_REPOS = new Set([
  "agent-town/agent-town",
  "lalalune/dungeons",
  "lalalune/dungeons-and-daemons",
]);
const BLOCKED_REGISTRY_APP_DISPLAY_NAMES = new Set([
  "agent-town",
  "dungeons-and-daemons",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export type {
  AppUiExtensionConfig,
  RegistryAppInfo,
  RegistryAppMeta,
  RegistryAppViewerMeta,
  RegistryPluginInfo,
  RegistryPluginListItem,
  RegistrySearchResult,
} from "./registry-client-types.js";

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

let memoryCache: {
  plugins: Map<string, RegistryPluginInfo>;
  fetchedAt: number;
  ttlMs?: number;
} | null = null;
let registryLoadPromise: Promise<Map<string, RegistryPluginInfo>> | null = null;

const LOCAL_FALLBACK_CACHE_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Network fetch + parse (inlined wire types — not exported)
// ---------------------------------------------------------------------------

async function fetchFromNetwork(): Promise<Map<string, RegistryPluginInfo>> {
  try {
    return await fetchRegistryFromNetwork({
      generatedRegistryUrl: GENERATED_REGISTRY_URL,
      indexRegistryUrl: INDEX_REGISTRY_URL,
      applyLocalWorkspaceApps,
      applyNodeModulePlugins,
      sanitizeSandbox,
    });
  } catch (err) {
    if (!isExpectedRegistryNetworkFallback(err)) {
      logger.warn(
        `[registry-client] generated-registry/index fallback failed: ${String(err)}`,
      );
    }
    throw err;
  }
}

async function buildLocalRegistrySnapshot(): Promise<
  Map<string, RegistryPluginInfo>
> {
  const plugins = new Map<string, RegistryPluginInfo>();
  await applyLocalWorkspaceApps(plugins);
  await applyNodeModulePlugins(plugins);
  return plugins;
}

// ---------------------------------------------------------------------------
// File cache
// ---------------------------------------------------------------------------

function cacheFilePath(): string {
  return path.join(resolveStateDir(), "cache", "registry.json");
}

function normalizeRegistryFilterKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s{0,32}&\s{0,32}/g, " and ")
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isBlockedRegistryPlugin(info: RegistryPluginInfo): boolean {
  const name = normalizeRegistryFilterKey(info.name);
  if (BLOCKED_REGISTRY_PLUGIN_NAMES.has(name)) {
    return true;
  }

  const npmPackage = normalizeRegistryFilterKey(info.npm.package);
  if (BLOCKED_REGISTRY_PLUGIN_NAMES.has(npmPackage)) {
    return true;
  }

  const gitRepo = normalizeRegistryFilterKey(info.gitRepo);
  if (BLOCKED_REGISTRY_PLUGIN_REPOS.has(gitRepo)) {
    return true;
  }

  const displayName = normalizeRegistryFilterKey(info.appMeta?.displayName);
  return BLOCKED_REGISTRY_APP_DISPLAY_NAMES.has(displayName);
}

function filterBlockedRegistryPlugins(
  plugins: Map<string, RegistryPluginInfo>,
): boolean {
  let removed = false;
  for (const [name, info] of plugins.entries()) {
    if (!isBlockedRegistryPlugin(info)) {
      continue;
    }
    plugins.delete(name);
    removed = true;
  }
  return removed;
}

async function readFileCache(): Promise<Map<
  string,
  RegistryPluginInfo
> | null> {
  try {
    const raw = await fs.readFile(cacheFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as {
      fetchedAt: number;
      plugins: Array<[string, RegistryPluginInfo]>;
    };
    if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.plugins))
      return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    const plugins = new Map(parsed.plugins);
    if (filterBlockedRegistryPlugins(plugins)) {
      writeFileCache(plugins).catch((err) =>
        logger.warn(`[registry-client] Cache rewrite failed: ${String(err)}`),
      );
    }
    return plugins;
  } catch {
    return null;
  }
}

async function writeFileCache(
  plugins: Map<string, RegistryPluginInfo>,
): Promise<void> {
  const filePath = cacheFilePath();
  const persistedPlugins = new Map(plugins);
  filterBlockedRegistryPlugins(persistedPlugins);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({
      fetchedAt: Date.now(),
      plugins: [...persistedPlugins.entries()],
    }),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Multi-endpoint management
// ---------------------------------------------------------------------------

/** Return the list of custom registry endpoints from config. */
export function getConfiguredEndpoints(): RegistryEndpoint[] {
  try {
    const cfg = loadElizaConfig();
    return cfg.plugins?.registryEndpoints ?? [];
  } catch (err) {
    logger.warn(
      `[registry-client] Failed to load config for custom endpoints: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

/** Add a custom registry endpoint. Blocks duplicate URLs. */
export function addRegistryEndpoint(label: string, url: string): void {
  const parsed = parseRegistryEndpointUrl(url);
  const normalised = normaliseEndpointUrl(parsed.toString());
  if (isDefaultEndpoint(normalised)) {
    throw new Error("Cannot add the default registry as a custom endpoint.");
  }
  const cfg = loadElizaConfig();
  const endpoints = cfg.plugins?.registryEndpoints ?? [];
  if (endpoints.some((ep) => normaliseEndpointUrl(ep.url) === normalised)) {
    throw new Error(`Endpoint already exists: ${url}`);
  }
  if (!cfg.plugins) cfg.plugins = {};
  cfg.plugins.registryEndpoints = [
    ...endpoints,
    { label, url: normalised, enabled: true },
  ];
  saveElizaConfig(cfg);
  memoryCache = null;
}

/** Remove a custom registry endpoint by URL. Cannot remove the default. */
export function removeRegistryEndpoint(url: string): void {
  const normalised = normaliseEndpointUrl(url);
  if (isDefaultEndpoint(normalised)) {
    throw new Error("Cannot remove the default elizaOS registry.");
  }
  const cfg = loadElizaConfig();
  const endpoints = cfg.plugins?.registryEndpoints ?? [];
  const updated = endpoints.filter(
    (ep) => normaliseEndpointUrl(ep.url) !== normalised,
  );
  if (updated.length === endpoints.length) {
    throw new Error(`Endpoint not found: ${url}`);
  }
  if (!cfg.plugins) cfg.plugins = {};
  cfg.plugins.registryEndpoints = updated;
  saveElizaConfig(cfg);
  memoryCache = null;
}

/** Toggle an endpoint's enabled status. */
export function toggleRegistryEndpoint(url: string, enabled: boolean): void {
  const normalised = normaliseEndpointUrl(url);
  const cfg = loadElizaConfig();
  const endpoints = cfg.plugins?.registryEndpoints ?? [];
  const ep = endpoints.find((e) => normaliseEndpointUrl(e.url) === normalised);
  if (!ep) throw new Error(`Endpoint not found: ${url}`);
  ep.enabled = enabled;
  if (!cfg.plugins) cfg.plugins = {};
  cfg.plugins.registryEndpoints = endpoints;
  saveElizaConfig(cfg);
  memoryCache = null;
}

export function isDefaultEndpoint(url: string): boolean {
  return isDefaultEndpointForUrl(url, GENERATED_REGISTRY_URL);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get all plugins. Resolution: memory → file → network. */
export async function getRegistryPlugins(): Promise<
  Map<string, RegistryPluginInfo>
> {
  if (
    memoryCache &&
    Date.now() - memoryCache.fetchedAt < (memoryCache.ttlMs ?? CACHE_TTL_MS)
  ) {
    return memoryCache.plugins;
  }

  const fromFile = await readFileCache();
  if (fromFile) {
    await applyLocalWorkspaceApps(fromFile);
    await applyNodeModulePlugins(fromFile);
    await mergeCustomEndpoints(fromFile, getConfiguredEndpoints());
    filterBlockedRegistryPlugins(fromFile);
    memoryCache = { plugins: fromFile, fetchedAt: Date.now() };
    return fromFile;
  }

  if (registryLoadPromise) {
    return registryLoadPromise;
  }

  registryLoadPromise = (async () => {
    logger.info(
      "[registry-client] Fetching plugin registry from next branch...",
    );
    let plugins: Map<string, RegistryPluginInfo>;
    let usedLocalFallback = false;
    try {
      plugins = await fetchFromNetwork();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isExpectedRegistryNetworkFallback(err)) {
        logger.debug(
          `[registry-client] Remote registry unavailable; using local registry discovery: ${message}`,
        );
      } else {
        logger.warn(
          `[registry-client] Falling back to local registry discovery: ${message}`,
        );
      }
      plugins = await buildLocalRegistrySnapshot();
      usedLocalFallback = true;
    }
    await mergeCustomEndpoints(plugins, getConfiguredEndpoints());
    filterBlockedRegistryPlugins(plugins);
    logger.info(`[registry-client] Loaded ${plugins.size} plugins`);

    memoryCache = {
      plugins,
      fetchedAt: Date.now(),
      ttlMs: usedLocalFallback ? LOCAL_FALLBACK_CACHE_TTL_MS : CACHE_TTL_MS,
    };
    if (!usedLocalFallback) {
      writeFileCache(plugins).catch((err) =>
        logger.warn(`[registry-client] Cache write failed: ${String(err)}`),
      );
    }

    return plugins;
  })().finally(() => {
    registryLoadPromise = null;
  });

  return registryLoadPromise;
}

/** Force-refresh from network. */
export async function refreshRegistry(): Promise<
  Map<string, RegistryPluginInfo>
> {
  memoryCache = null;
  try {
    await fs.unlink(cacheFilePath());
  } catch {
    /* noop */
  }
  return getRegistryPlugins();
}

/** Look up a plugin by name (exact → @elizaos/ prefix → bare suffix). */
export async function getPluginInfo(
  name: string,
): Promise<RegistryPluginInfo | null> {
  const registry = await getRegistryPlugins();
  const normalizedName = normalizePluginLookupAlias(name);
  const candidates = Array.from(new Set([normalizedName, name]));

  for (const candidate of candidates) {
    const info = getPluginInfoFromRegistry(registry, candidate);
    if (info) return info;
  }

  return null;
}

/** Search plugins by query (local fuzzy match on name/description/topics). */
export async function searchPlugins(
  query: string,
  limit = 15,
): Promise<RegistrySearchResult[]> {
  const registry = await getRegistryPlugins();
  const results = scoreEntries(registry.values(), query, limit);
  return toSearchResults(results);
}

/** List all registered apps. */
export async function listApps(): Promise<RegistryAppInfo[]> {
  const registry = await getRegistryPlugins();
  const apps: RegistryAppInfo[] = [];

  for (const p of registry.values()) {
    const appEntry = toAppEntry(p, resolveAppOverride);
    if (!appEntry) continue;
    apps.push(toAppInfo(appEntry, sanitizeSandbox, LOCAL_APP_DEFAULT_SANDBOX));
  }

  apps.sort((a, b) => b.stars - a.stars);
  return apps;
}

/** Look up a specific app by name. */
export async function getAppInfo(
  name: string,
): Promise<RegistryAppInfo | null> {
  const info = await getPluginInfo(name);
  if (!info) return null;
  const appEntry = toAppEntry(info, resolveAppOverride);
  if (!appEntry) return null;
  return toAppInfo(appEntry, sanitizeSandbox, LOCAL_APP_DEFAULT_SANDBOX);
}

/** Search apps by query. */
export async function searchApps(
  query: string,
  limit = 15,
): Promise<RegistryAppInfo[]> {
  const registry = await getRegistryPlugins();
  const appEntries: RegistryPluginInfo[] = [];
  for (const p of registry.values()) {
    const appEntry = toAppEntry(p, resolveAppOverride);
    if (appEntry) appEntries.push(appEntry);
  }

  const results = scoreEntries(
    appEntries,
    query,
    limit,
    (p) => [p.appMeta?.displayName?.toLowerCase() ?? ""],
    (p) => p.appMeta?.capabilities ?? [],
  );

  return results.map(({ p }) =>
    toAppInfo(p, sanitizeSandbox, LOCAL_APP_DEFAULT_SANDBOX),
  );
}

/** List all non-app plugins from the registry. */
export async function listNonAppPlugins(): Promise<RegistryPluginListItem[]> {
  const registry = await getRegistryPlugins();
  const plugins: RegistryPluginListItem[] = [];

  for (const p of registry.values()) {
    if (p.kind !== "app") {
      plugins.push(toPluginListItem(p));
    }
  }

  plugins.sort((a, b) => b.stars - a.stars);
  return plugins;
}

/** Search non-app plugins by query. */
export async function searchNonAppPlugins(
  query: string,
  limit = 15,
): Promise<RegistryPluginListItem[]> {
  const registry = await getRegistryPlugins();
  const pluginEntries = [...registry.values()].filter((p) => p.kind !== "app");

  const results = scoreEntries(pluginEntries, query, limit);
  return results.map(({ p }) => toPluginListItem(p));
}

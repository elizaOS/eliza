/**
 * Registry Client for Milady.
 *
 * Provides a 3-tier cached registry (memory → file → network) that works
 * offline, in .app bundles, and in dev. Fetches from the next branch.
 *
 * @module services/registry-client
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { loadMiladyConfig, saveMiladyConfig } from "../config/config.js";
import type { RegistryEndpoint } from "../config/types.milady.js";
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
import { fetchFromNetwork as fetchRegistryFromNetwork } from "./registry-client-network.js";
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
} | null = null;

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
    logger.warn(
      `[registry-client] generated-registry/index fallback failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// File cache
// ---------------------------------------------------------------------------

function cacheFilePath(): string {
  const base =
    process.env.MILADY_STATE_DIR?.trim() || path.join(os.homedir(), ".milady");
  return path.join(base, "cache", "registry.json");
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
    return new Map(parsed.plugins);
  } catch {
    return null;
  }
}

async function writeFileCache(
  plugins: Map<string, RegistryPluginInfo>,
): Promise<void> {
  const filePath = cacheFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({ fetchedAt: Date.now(), plugins: [...plugins.entries()] }),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Multi-endpoint management
// ---------------------------------------------------------------------------

/** Return the list of custom registry endpoints from config. */
export function getConfiguredEndpoints(): RegistryEndpoint[] {
  try {
    const cfg = loadMiladyConfig();
    return cfg.plugins?.registryEndpoints ?? [];
  } catch {
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
  const cfg = loadMiladyConfig();
  const endpoints = cfg.plugins?.registryEndpoints ?? [];
  if (endpoints.some((ep) => normaliseEndpointUrl(ep.url) === normalised)) {
    throw new Error(`Endpoint already exists: ${url}`);
  }
  if (!cfg.plugins) cfg.plugins = {};
  cfg.plugins.registryEndpoints = [
    ...endpoints,
    { label, url: normalised, enabled: true },
  ];
  saveMiladyConfig(cfg);
  memoryCache = null;
}

/** Remove a custom registry endpoint by URL. Cannot remove the default. */
export function removeRegistryEndpoint(url: string): void {
  const normalised = normaliseEndpointUrl(url);
  if (isDefaultEndpoint(normalised)) {
    throw new Error("Cannot remove the default elizaOS registry.");
  }
  const cfg = loadMiladyConfig();
  const endpoints = cfg.plugins?.registryEndpoints ?? [];
  const updated = endpoints.filter(
    (ep) => normaliseEndpointUrl(ep.url) !== normalised,
  );
  if (updated.length === endpoints.length) {
    throw new Error(`Endpoint not found: ${url}`);
  }
  if (!cfg.plugins) cfg.plugins = {};
  cfg.plugins.registryEndpoints = updated;
  saveMiladyConfig(cfg);
  memoryCache = null;
}

/** Toggle an endpoint's enabled status. */
export function toggleRegistryEndpoint(url: string, enabled: boolean): void {
  const normalised = normaliseEndpointUrl(url);
  const cfg = loadMiladyConfig();
  const endpoints = cfg.plugins?.registryEndpoints ?? [];
  const ep = endpoints.find((e) => normaliseEndpointUrl(e.url) === normalised);
  if (!ep) throw new Error(`Endpoint not found: ${url}`);
  ep.enabled = enabled;
  if (!cfg.plugins) cfg.plugins = {};
  cfg.plugins.registryEndpoints = endpoints;
  saveMiladyConfig(cfg);
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
  if (memoryCache && Date.now() - memoryCache.fetchedAt < CACHE_TTL_MS) {
    return memoryCache.plugins;
  }

  const fromFile = await readFileCache();
  if (fromFile) {
    await applyLocalWorkspaceApps(fromFile);
    await applyNodeModulePlugins(fromFile);
    await mergeCustomEndpoints(fromFile, getConfiguredEndpoints());
    memoryCache = { plugins: fromFile, fetchedAt: Date.now() };
    return fromFile;
  }

  logger.info("[registry-client] Fetching plugin registry from next branch...");
  const plugins = await fetchFromNetwork();
  await mergeCustomEndpoints(plugins, getConfiguredEndpoints());
  logger.info(`[registry-client] Loaded ${plugins.size} plugins`);

  memoryCache = { plugins, fetchedAt: Date.now() };
  writeFileCache(plugins).catch((err) =>
    logger.warn(
      `[registry-client] Cache write failed: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );

  return plugins;
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

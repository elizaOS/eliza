/**
 * Registry Client for Eliza.
 *
 * Provides a 3-tier cached registry (memory → file → network) that works
 * offline, in .app bundles, and in dev. Fetches from plugins.eliza.app.
 *
 * @module services/registry-client
 */

import path from "node:path";
import { logger } from "@elizaos/core";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import { resolveStateDir } from "../config/paths.ts";
import type { RegistryEndpoint } from "../config/types.eliza.ts";
import {
  LOCAL_APP_DEFAULT_SANDBOX,
  resolveAppOverride,
  sanitizeSandbox,
} from "./registry-client-app-meta.ts";
import {
  isDefaultEndpoint as isDefaultEndpointForUrl,
  mergeCustomEndpoints,
  normaliseEndpointUrl,
  parseRegistryEndpointUrl,
} from "./registry-client-endpoints.ts";
import {
  applyLocalWorkspaceApps,
  applyNodeModulePlugins,
} from "./registry-client-local.ts";
import {
  getPluginInfoFromRegistry,
  normalizePluginLookupAlias,
  scoreEntries,
  toAppEntry,
  toAppInfo,
  toPluginListItem,
  toSearchResults,
} from "./registry-client-queries.ts";
import {
  createFileRegistryCacheStore,
  type RegistryCacheRecord,
  type RegistryCacheStore,
  RegistryClient,
  type RegistryClientOptions,
} from "./registry-client-runtime.ts";
import type {
  RegistryAppInfo,
  RegistryPluginInfo,
  RegistryPluginListItem,
  RegistrySearchResult,
} from "./registry-client-types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERATED_REGISTRY_URL =
  "https://plugins.eliza.app/generated-registry.json";
const INDEX_REGISTRY_URL = "https://plugins.eliza.app/index.json";

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
} from "./registry-client-types.ts";

function cacheFilePath(): string {
  return path.join(resolveStateDir(), "cache", "registry.json");
}

export {
  createFileRegistryCacheStore,
  type RegistryCacheRecord,
  type RegistryCacheStore,
  RegistryClient,
  type RegistryClientOptions,
};

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
  defaultRegistryClient.invalidateMemory();
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
  defaultRegistryClient.invalidateMemory();
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
  defaultRegistryClient.invalidateMemory();
}

export function isDefaultEndpoint(url: string): boolean {
  return isDefaultEndpointForUrl(url, GENERATED_REGISTRY_URL);
}

const defaultRegistryClient = new RegistryClient({
  generatedRegistryUrl: GENERATED_REGISTRY_URL,
  indexRegistryUrl: INDEX_REGISTRY_URL,
  cacheStore: createFileRegistryCacheStore(cacheFilePath),
  applyLocalWorkspaceApps,
  applyNodeModulePlugins,
  sanitizeSandbox,
  getConfiguredEndpoints,
  mergeCustomEndpoints,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get all plugins. Resolution: memory → file → network. */
export async function getRegistryPlugins(): Promise<
  Map<string, RegistryPluginInfo>
> {
  return defaultRegistryClient.getRegistryPlugins();
}

/** Force-refresh from network. */
export async function refreshRegistry(): Promise<
  Map<string, RegistryPluginInfo>
> {
  return defaultRegistryClient.refreshRegistry();
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

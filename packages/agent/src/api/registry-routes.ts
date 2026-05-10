import type { RouteHelpers, RouteRequestMeta } from "@elizaos/core";
import type {
  RegistryPluginInfo,
  RegistrySearchResult,
} from "../services/plugin-manager-types.ts";
import { parseClampedInteger } from "../utils/number-parsing.ts";

interface InstalledRegistryPluginLike {
  name: string;
  version?: string | null;
  releaseStream?: "latest" | "beta";
  latestVersion?: string | null;
  betaVersion?: string | null;
}

interface RegistryPluginManagerLike {
  refreshRegistry: () => Promise<Map<string, RegistryPluginInfo>>;
  listInstalledPlugins: () => Promise<InstalledRegistryPluginLike[]>;
  getRegistryPlugin: (name: string) => Promise<RegistryPluginInfo | null>;
  searchRegistry: (
    query: string,
    limit: number,
  ) => Promise<RegistrySearchResult[]>;
}

export interface RegistryRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  url: URL;
  getPluginManager: () => RegistryPluginManagerLike;
  getLoadedPluginNames: () => string[];
  getBundledPluginIds: () => Set<string>;
  classifyRegistryPluginRelease: (params: {
    packageName: string;
    bundledPluginIds: ReadonlySet<string>;
    kind?: string;
  }) => unknown;
}

export async function handleRegistryRoutes(
  ctx: RegistryRouteContext,
): Promise<boolean> {
  const {
    res,
    method,
    pathname,
    url,
    json,
    error,
    getPluginManager,
    getLoadedPluginNames,
    getBundledPluginIds,
    classifyRegistryPluginRelease,
  } = ctx;

  if (method === "GET" && pathname === "/api/registry/plugins") {
    try {
      const pluginManager = getPluginManager();
      const registry = await pluginManager.refreshRegistry();
      const installed = await pluginManager.listInstalledPlugins();
      const installedNames = new Set(installed.map((plugin) => plugin.name));
      const loadedNames = new Set(getLoadedPluginNames());
      const bundledIds = getBundledPluginIds();

      const plugins = Array.from(registry.values()).map((plugin) => {
        const shortId = plugin.name
          .replace(/^@[^/]+\/plugin-/, "")
          .replace(/^@[^/]+\//, "")
          .replace(/^plugin-/, "");
        const bundled = bundledIds.has(shortId);
        return {
          ...plugin,
          installed: installedNames.has(plugin.name),
          installedVersion:
            installed.find((entry) => entry.name === plugin.name)?.version ??
            null,
          releaseStream:
            installed.find((entry) => entry.name === plugin.name)
              ?.releaseStream ?? null,
          betaVersion:
            installed.find((entry) => entry.name === plugin.name)
              ?.betaVersion ?? null,
          latestVersion:
            installed.find((entry) => entry.name === plugin.name)
              ?.latestVersion ??
            plugin.npm?.v2Version ??
            null,
          loaded:
            loadedNames.has(plugin.name) ||
            loadedNames.has(plugin.name.replace("@elizaos/", "")),
          bundled,
          compatibility: classifyRegistryPluginRelease({
            packageName: plugin.name,
            bundledPluginIds: bundledIds,
            kind: plugin.kind,
          }),
        };
      });
      json(res, { count: plugins.length, plugins });
    } catch (err) {
      error(res, `Failed to fetch registry: ${String(err)}`, 502);
    }
    return true;
  }

  if (
    method === "GET" &&
    pathname.startsWith("/api/registry/plugins/") &&
    pathname.length > "/api/registry/plugins/".length
  ) {
    const name = decodeURIComponent(
      pathname.slice("/api/registry/plugins/".length),
    );
    try {
      const pluginManager = getPluginManager();
      const info = await pluginManager.getRegistryPlugin(name);
      if (!info) {
        error(res, `Plugin "${name}" not found in registry`, 404);
        return true;
      }
      json(res, { plugin: info });
    } catch (err) {
      error(res, `Failed to look up plugin: ${String(err)}`, 502);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/registry/search") {
    const query = url.searchParams.get("q") || "";
    if (!query.trim()) {
      error(res, "Query parameter 'q' is required", 400);
      return true;
    }

    try {
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam
        ? parseClampedInteger(limitParam, { min: 1, max: 50, fallback: 15 })
        : 15;

      const pluginManager = getPluginManager();
      const results = await pluginManager.searchRegistry(query, limit);
      json(res, { query, count: results.length, results });
    } catch (err) {
      error(res, `Search failed: ${String(err)}`, 502);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/registry/refresh") {
    try {
      const pluginManager = getPluginManager();
      const registry = await pluginManager.refreshRegistry();
      json(res, { ok: true, count: registry.size });
    } catch (err) {
      error(res, `Refresh failed: ${String(err)}`, 502);
    }
    return true;
  }

  return false;
}

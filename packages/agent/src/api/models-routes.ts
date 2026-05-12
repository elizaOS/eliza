import type { RouteHelpers, RouteRequestMeta } from "@elizaos/core";

export interface ModelsRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json"> {
  url: URL;
  providerCachePath: (provider: string) => string;
  getOrFetchProvider: (provider: string, force: boolean) => Promise<unknown[]>;
  getOrFetchAllProviders: (
    force: boolean,
  ) => Promise<Record<string, unknown[]>>;
  resolveModelsCacheDir: () => string;
  pathExists: (targetPath: string) => boolean;
  readDir: (targetPath: string) => string[];
  unlinkFile: (targetPath: string) => void;
  joinPath: (left: string, right: string) => string;
}

export async function handleModelsRoutes(
  ctx: ModelsRouteContext,
): Promise<boolean> {
  const {
    res,
    method,
    pathname,
    url,
    json,
    providerCachePath,
    getOrFetchProvider,
    getOrFetchAllProviders,
    resolveModelsCacheDir,
    pathExists,
    readDir,
    unlinkFile,
    joinPath,
  } = ctx;

  if (method !== "GET" || pathname !== "/api/models") return false;

  const force = url.searchParams.get("refresh") === "true";
  const specificProvider = url.searchParams.get("provider");

  if (specificProvider) {
    if (force) {
      try {
        unlinkFile(providerCachePath(specificProvider));
      } catch {
        // Ignore cache-bust errors and continue with a fresh fetch.
      }
    }
    const models = await getOrFetchProvider(specificProvider, force);
    json(res, { provider: specificProvider, models });
    return true;
  }

  if (force) {
    try {
      const dir = resolveModelsCacheDir();
      if (pathExists(dir)) {
        for (const file of readDir(dir)) {
          if (file.endsWith(".json")) unlinkFile(joinPath(dir, file));
        }
      }
    } catch {
      // Ignore cache-bust errors and continue with a fresh fetch.
    }
  }

  const all = await getOrFetchAllProviders(force);
  json(res, { providers: all });
  return true;
}

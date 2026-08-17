/**
 * Serves `GET /api/models`, the model-catalog endpoint behind the dashboard
 * control-API auth gate. Returns provider model lists from an on-disk cache:
 * `?provider=` narrows to one provider, `?refresh=true` busts the cache (a
 * single provider's file, or every cached `.json` for an all-providers fetch)
 * before refetching. Every response additionally carries a `catalog` field —
 * the validated provider→model→efforts catalog (model-catalog.ts) that
 * `POST /api/models/config` writes are checked against. Filesystem and fetch
 * access are injected through the route context so the handler stays
 * transport-agnostic and unit-testable.
 */
import {
  parseBooleanValue,
  type RouteHelpers,
  type RouteRequestMeta,
} from "@elizaos/core";
import { buildModelCatalog, type ModelCatalog } from "./model-catalog.ts";
import { MODEL_PROVIDER_ID_PATTERN } from "./model-provider-helpers.ts";

function parseOptionalBooleanQuery(
  raw: string | null,
): { ok: true; value?: boolean } | { ok: false } {
  if (raw === null) return { ok: true };
  const parsed = parseBooleanValue(raw);
  if (parsed === undefined) return { ok: false };
  return { ok: true, value: parsed };
}

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
  /** Injectable catalog builder for tests; defaults to buildModelCatalog. */
  buildCatalog?: () => ModelCatalog;
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

  const catalogOnlyParsed = parseOptionalBooleanQuery(
    url.searchParams.get("catalogOnly"),
  );
  if (!catalogOnlyParsed.ok) {
    json(res, { error: "catalogOnly must be a boolean" }, 400);
    return true;
  }
  const refreshParsed = parseOptionalBooleanQuery(
    url.searchParams.get("refresh"),
  );
  if (!refreshParsed.ok) {
    json(res, { error: "refresh must be a boolean" }, 400);
    return true;
  }
  const force = refreshParsed.value === true;
  const specificProvider = url.searchParams.get("provider");
  // Built per request: the codex slice re-reads the CLI's models_cache.json
  // at call time so a refreshed server catalog shows up without a restart.
  const catalog = (ctx.buildCatalog ?? buildModelCatalog)();

  // Catalog consumers (the settings model panel, slash-command completions)
  // only need the validated catalog — local static tables + one file read.
  // The all-providers fan-out below hits every provider's live model-list API
  // and takes tens of seconds on a cold cache, which blows the UI client's
  // 10s fetch budget and renders as a failed options load.
  // Accept both shipped identities: UI catalog path uses `1`, refresh uses `true`.
  if (catalogOnlyParsed.value === true) {
    json(res, { providers: {}, catalog });
    return true;
  }

  if (specificProvider) {
    // The provider id becomes a filesystem path segment in providerCachePath,
    // so reject anything outside the canonical id grammar before the cache
    // bust or fetch runs — `../` ids would otherwise traverse the unlink/read
    // out of the models cache dir (W1-024).
    if (!MODEL_PROVIDER_ID_PATTERN.test(specificProvider)) {
      json(res, { error: "Invalid provider id" }, 400);
      return true;
    }
    if (force) {
      try {
        unlinkFile(providerCachePath(specificProvider));
      } catch {
        // Ignore cache-bust errors and continue with a fresh fetch.
      }
    }
    const models = await getOrFetchProvider(specificProvider, force);
    json(res, { provider: specificProvider, models, catalog });
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
  json(res, { providers: all, catalog });
  return true;
}

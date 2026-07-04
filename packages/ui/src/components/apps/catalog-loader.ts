import { client, type RegistryAppInfo } from "../../api";
import { isHiddenFromAppsView } from "./helpers";
import {
  buildInternalToolAppViewOverlays,
  getInternalToolApps,
  type InternalToolAppViewOverlay,
} from "./internal-tool-apps";
import {
  getAllOverlayApps,
  getAvailableOverlayApps,
  isAospAndroid,
  overlayAppToRegistryInfo,
} from "./overlay-app-registry";

interface LoadMergedCatalogAppsOptions {
  includeHiddenApps?: boolean;
}

/**
 * Fetch the plugin-declared view metadata (GET /api/views) that overlays the
 * internal-tool catalog, keyed by view id. Returns an empty map when the
 * endpoint is unavailable (e.g. cloud runtimes that don't serve /api/views, or
 * a runtime still booting) so the catalog falls back to the literal metadata.
 */
export async function fetchInternalToolAppViewOverlays(): Promise<
  Map<string, InternalToolAppViewOverlay>
> {
  const result = await client
    .fetch<{ views: InternalToolAppViewOverlay[] }>("/api/views")
    .then((value) => ({ status: "fulfilled" as const, value }))
    .catch(() => ({ status: "rejected" as const }));
  if (result.status === "rejected" || !Array.isArray(result.value?.views)) {
    return new Map();
  }
  return buildInternalToolAppViewOverlays(result.value.views);
}

export async function loadMergedCatalogApps({
  includeHiddenApps = false,
}: LoadMergedCatalogAppsOptions = {}): Promise<RegistryAppInfo[]> {
  const [catalogAppsResult, installedAppsResult, viewsById] = await Promise.all(
    [
      client.listCatalogApps().then(
        (value) => ({ status: "fulfilled" as const, value }),
        () => ({ status: "rejected" as const }),
      ),
      client.listApps().then(
        (value) => ({ status: "fulfilled" as const, value }),
        () => ({ status: "rejected" as const }),
      ),
      fetchInternalToolAppViewOverlays(),
    ],
  );

  const catalogApps =
    catalogAppsResult.status === "fulfilled" ? catalogAppsResult.value : [];
  const installedApps =
    installedAppsResult.status === "fulfilled" ? installedAppsResult.value : [];
  const staticApps = [...getInternalToolApps(viewsById), ...catalogApps];
  // `getAvailableOverlayApps()` drops `androidOnly: true` apps outside
  // AOSP Eliza-derived Android so WiFi / Contacts / Phone tiles never appear
  // in stock Android, iOS, desktop, or web builds.
  const overlayApps = getAvailableOverlayApps()
    .filter(
      (app) => !staticApps.some((candidate) => candidate.name === app.name),
    )
    .filter(
      (app) => !installedApps.some((candidate) => candidate.name === app.name),
    )
    .map(overlayAppToRegistryInfo);

  // Keep the FIRST occurrence so internal-tool apps (which carry hero images
  // and the canonical catalog metadata) win over duplicate `installedApps`
  // entries that lack heroImage/category etc.
  const seenNames = new Set<string>();
  const mergedApps = [...staticApps, ...overlayApps, ...installedApps].filter(
    (app) => {
      if (seenNames.has(app.name)) return false;
      seenNames.add(app.name);
      return true;
    },
  );

  // The same AOSP-only gate applied to overlayApps must also strip
  // `androidOnly` apps that arrived through `staticApps` or `installedApps`.
  // The agent's plugin-resolver returns the runtime halves of the phone /
  // contacts / wifi packages whenever they're loaded, and the elizaOS
  // curated catalog lists their canonical names — both paths feed
  // `installedApps` / `catalogApps` and would otherwise leak the privileged
  // tiles into stock Android, iOS, desktop, and web catalogs.
  const aospOnly = isAospAndroid();
  const androidOnlyAppNames = new Set(
    getAllOverlayApps()
      .filter((app) => app.androidOnly === true)
      .map((app) => app.name),
  );
  const platformFilteredApps = aospOnly
    ? mergedApps
    : mergedApps.filter((app) => !androidOnlyAppNames.has(app.name));

  return includeHiddenApps
    ? platformFilteredApps
    : platformFilteredApps.filter((app) => !isHiddenFromAppsView(app.name));
}

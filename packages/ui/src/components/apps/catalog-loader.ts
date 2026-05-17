import { client, type RegistryAppInfo } from "../../api";
import { isHiddenFromAppsView } from "./helpers";
import { getInternalToolApps } from "./internal-tool-apps";
import {
  getAllOverlayApps,
  getAvailableOverlayApps,
  isAospAndroid,
  overlayAppToRegistryInfo,
} from "./overlay-app-registry";

interface LoadMergedCatalogAppsOptions {
  includeHiddenApps?: boolean;
}

export async function loadMergedCatalogApps({
  includeHiddenApps = false,
}: LoadMergedCatalogAppsOptions = {}): Promise<RegistryAppInfo[]> {
  const [catalogAppsResult, installedAppsResult] = await Promise.allSettled([
    client.listCatalogApps(),
    client.listApps(),
  ]);

  const catalogApps =
    catalogAppsResult.status === "fulfilled" ? catalogAppsResult.value : [];
  const installedApps =
    installedAppsResult.status === "fulfilled" ? installedAppsResult.value : [];
  const staticApps = [...getInternalToolApps(), ...catalogApps];
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

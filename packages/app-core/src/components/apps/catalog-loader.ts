import { client, type RegistryAppInfo } from "../../api";
import { isHiddenFromAppsView } from "./helpers";
import { getInternalToolApps } from "./internal-tool-apps";
import {
  getAvailableOverlayApps,
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
  // MiladyOS Android so WiFi / Contacts / Phone tiles never appear in stock
  // Android, iOS, desktop, or web builds.
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

  return includeHiddenApps
    ? mergedApps
    : mergedApps.filter((app) => !isHiddenFromAppsView(app.name));
}

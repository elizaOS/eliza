import { client, type RegistryAppInfo } from "../../api";
import { isHiddenFromAppsView } from "./helpers";
import { getInternalToolApps } from "./internal-tool-apps";
import {
  getAllOverlayApps,
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
  const overlayApps = getAllOverlayApps()
    .filter(
      (app) => !staticApps.some((candidate) => candidate.name === app.name),
    )
    .filter(
      (app) => !installedApps.some((candidate) => candidate.name === app.name),
    )
    .map(overlayAppToRegistryInfo);

  const mergedApps = [...staticApps, ...overlayApps, ...installedApps].filter(
    (app, index, items) =>
      !items.slice(index + 1).some((candidate) => candidate.name === app.name),
  );

  return includeHiddenApps
    ? mergedApps
    : mergedApps.filter((app) => !isHiddenFromAppsView(app.name));
}

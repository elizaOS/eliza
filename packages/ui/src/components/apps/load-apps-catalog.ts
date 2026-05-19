import { client, type RegistryAppInfo } from "../../api";
import { writeAppsCache } from "./apps-cache";
import { getInternalToolApps } from "./internal-tool-apps";
import {
  getAvailableOverlayApps,
  overlayAppToRegistryInfo,
} from "./overlay-app-registry";

/**
 * Fetch the merged apps catalog used by AppsView. Internal-tool entries are
 * authoritative — server / overlay duplicates are dropped via first-occurrence
 * dedup on `name`.
 */
export async function loadAppsCatalog(): Promise<RegistryAppInfo[]> {
  const serverAppsResult = await client
    .listApps()
    .then((apps) => ({ status: "fulfilled" as const, value: apps }))
    .catch((reason) => ({ status: "rejected" as const, reason }));
  const serverApps =
    serverAppsResult.status === "fulfilled" ? serverAppsResult.value : [];
  // non-transient server list failure is silent; catalog + overlay entries fill the gap

  let catalogApps: RegistryAppInfo[];
  try {
    catalogApps = [
      ...getInternalToolApps(),
      ...(await client.listCatalogApps()),
    ];
  } catch {
    catalogApps = getInternalToolApps();
  }

  const overlayDescriptors = getAvailableOverlayApps()
    .filter((oa) => !serverApps.some((a) => a.name === oa.name))
    .filter((oa) => !catalogApps.some((a) => a.name === oa.name))
    .map(overlayAppToRegistryInfo);

  const seen = new Set<string>();
  return [...catalogApps, ...overlayDescriptors, ...serverApps].filter(
    (app) => {
      if (seen.has(app.name)) return false;
      seen.add(app.name);
      return true;
    },
  );
}

/**
 * Fire-and-forget prefetch used at hydration so the Apps tab opens warm.
 * Errors are swallowed — the UI's own loadApps will retry on mount.
 */
export async function prefetchAppsCatalog(): Promise<void> {
  try {
    const apps = await loadAppsCatalog();
    writeAppsCache(apps);
  } catch {
    // prefetch failure is silent; AppsView loads on mount
  }
}

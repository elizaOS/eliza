import { client, type RegistryAppInfo } from "../../api";
import { writeAppsCache } from "./apps-cache";
import { getInternalToolApps } from "./internal-tool-apps";
import {
  getAllOverlayApps,
  overlayAppToRegistryInfo,
} from "./overlay-app-registry";

function isTransientOptionalFetchFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const maybeApiError = err as Error & {
    kind?: string;
  };
  return (
    err.name === "ApiError" &&
    maybeApiError.kind === "network" &&
    /^(Failed to fetch|Request aborted)$/i.test(err.message)
  );
}

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
  if (
    serverAppsResult.status === "rejected" &&
    !isTransientOptionalFetchFailure(serverAppsResult.reason)
  ) {
    console.warn("[apps-catalog] listApps failed:", serverAppsResult.reason);
  }

  let catalogApps: RegistryAppInfo[];
  try {
    catalogApps = [
      ...getInternalToolApps(),
      ...(await client.listCatalogApps()),
    ];
  } catch (catalogErr) {
    if (!isTransientOptionalFetchFailure(catalogErr)) {
      console.warn(
        "[apps-catalog] listCatalogApps failed; using internal tools:",
        catalogErr,
      );
    }
    catalogApps = getInternalToolApps();
  }

  const overlayDescriptors = getAllOverlayApps()
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
  } catch (err) {
    if (!isTransientOptionalFetchFailure(err)) {
      console.warn("[apps-catalog] prefetch failed:", err);
    }
  }
}

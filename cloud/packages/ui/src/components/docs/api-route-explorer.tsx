import type { DiscoveredApiRouteDto } from "@/types/cloud-api";
import { ApiRouteExplorerClient } from "./api-route-explorer-client";

/**
 * Presentational API route explorer. Route discovery is owned by the app/docs layer.
 */
export function ApiRouteExplorer({ routes }: { routes: DiscoveredApiRouteDto[] }) {
  return <ApiRouteExplorerClient routes={routes} />;
}

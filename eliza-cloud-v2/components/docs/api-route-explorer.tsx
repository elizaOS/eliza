import { discoverApiV1Routes } from "@/lib/docs/api-route-discovery";
import { ApiRouteExplorerClient } from "@/components/docs/api-route-explorer-client";

/**
 * Server component that discovers real `app/api/v1/<...>/route.ts` endpoints at build/runtime
 * and renders a searchable, docs-friendly explorer UI.
 */
export async function ApiRouteExplorer() {
  const routes = await discoverApiV1Routes();
  return <ApiRouteExplorerClient routes={routes} />;
}

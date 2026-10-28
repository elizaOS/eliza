/**
 * POST /api/v1/maps/routes: routes for one travel mode, with optional alternatives.
 * Authenticated, subscription-bound and rate limited; see src/lib/maps-route.ts.
 */
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { createMapsRoute } from "@/api-app/lib/maps-route";

const route: Hono<AppEnv> = createMapsRoute("routes");
export default route;

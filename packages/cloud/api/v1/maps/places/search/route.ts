/**
 * POST /api/v1/maps/places/search: place search, optionally biased near a coordinate.
 * Authenticated, subscription-bound and rate limited; see src/lib/maps-route.ts.
 */
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { createMapsRoute } from "@/api-app/lib/maps-route";

const route: Hono<AppEnv> = createMapsRoute("search");
export default route;

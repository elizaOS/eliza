/**
 * GET /api/v1/maps/tiles/{z}/{x}/{y}: one raster roadmap tile from the
 * configured provider (Google Map Tiles API), with the tile session held by
 * Cloud. Authenticated, subscription-bound and admitted like every Maps
 * operation (one request unit and a unique Idempotency-Key per tile); see
 * src/lib/maps-route.ts.
 */
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { createMapsRoute } from "../../../../../../src/lib/maps-route";

const route: Hono<AppEnv> = createMapsRoute("tiles");
export default route;

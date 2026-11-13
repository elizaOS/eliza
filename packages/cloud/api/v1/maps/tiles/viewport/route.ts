/**
 * POST /api/v1/maps/tiles/viewport: the provider's copyright text for the
 * visible map area (`{zoom, north, south, east, west}` in the body), which a
 * host showing Cloud tiles must display. Authenticated and subscription-bound
 * like coverage; it is metadata and consumes no Maps request allowance. See
 * src/lib/maps-route.ts.
 */
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { createMapsRoute } from "../../../../src/lib/maps-route";

const route: Hono<AppEnv> = createMapsRoute("viewport");
export default route;

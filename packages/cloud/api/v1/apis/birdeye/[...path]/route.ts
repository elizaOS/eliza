/**
 * Birdeye market-data proxy (canonical).
 *
 * GET /api/v1/apis/birdeye/{path} — same behavior as the legacy
 * `/api/v1/proxy/birdeye/*` mount; callers should prefer this URL.
 */

import { Hono } from "hono";
import { handleBirdeyeMarketDataProxyGet } from "@/lib/services/proxy/birdeye-handler";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/*", handleBirdeyeMarketDataProxyGet);

export default app;

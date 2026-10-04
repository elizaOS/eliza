/**
 * DexScreener API proxy — GET /api/v1/apis/dexscreener/latest/...
 */

import { handleDexscreenerProxyGet } from "@elizaos/cloud-shared/lib/services/proxy/dexscreener-handler";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/*", handleDexscreenerProxyGet);

export default app;

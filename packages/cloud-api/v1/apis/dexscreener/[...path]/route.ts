/**
 * DexScreener API proxy — GET /api/v1/apis/dexscreener/latest/...
 */

import { Hono } from "hono";
import { handleDexscreenerProxyGet } from "@/lib/services/proxy/dexscreener-handler";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/*", handleDexscreenerProxyGet);

export default app;

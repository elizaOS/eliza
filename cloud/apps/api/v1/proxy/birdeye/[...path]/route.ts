/**
 * Legacy Birdeye proxy mount — redirects to `/api/v1/apis/birdeye/*` (308).
 */

import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/*", (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace("/api/v1/proxy/birdeye", "/api/v1/apis/birdeye");
  return c.redirect(url.toString(), 308);
});

export default app;

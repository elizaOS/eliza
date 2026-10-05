/**
 * Legacy Birdeye proxy mount — redirects to `/api/v1/apis/birdeye/*` (308).
 */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

// The router mounts this sub-app at `/api/v1/proxy/birdeye/:*{.+}`. When the
// splat captures the rest of the path the sub-app sees an empty inner path,
// so `app.get("/*")` doesn't match — we need a wildcard that also matches
// empty. Use `app.all("*")` which matches any inner path including "".
app.all("*", (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(
    "/api/v1/proxy/birdeye",
    "/api/v1/apis/birdeye",
  );
  return c.redirect(url.toString(), 308);
});

export default app;

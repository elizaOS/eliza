// Handles v1 cloud API v1 cron node autoscale route traffic with route-local auth expectations.
import { Hono } from "hono";

/**
 * Node autoscale cron handler.
 *
 * Cloudflare Workers validate cron auth here and forward to the Node/Bun
 * container control plane. Autoscale can provision Hetzner servers and later
 * drain them; keeping it on the sidecar keeps HCloud and SSH credentials out of
 * the Worker runtime.
 */

import { verifyCronSecret } from "@/lib/auth/cron";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { cronSupersededByDaemon } from "../../_container-control-plane-forward";

async function handleAutoscale(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(c.req.raw, "[Node Autoscale]", env);
  if (authError) return authError;
  return cronSupersededByDaemon(c, "processNodeAutoscaleCycle");
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => handleAutoscale(c, c.env));
__hono_app.post("/", async (c) => handleAutoscale(c, c.env));
export default __hono_app;

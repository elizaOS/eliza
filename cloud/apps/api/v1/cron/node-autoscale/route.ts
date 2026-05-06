import { Hono } from "hono";

/**
 * Node autoscale cron handler.
 *
 * Cloudflare Workers validate cron auth here and forward to the Node/Bun
 * container control plane. Autoscale can provision Hetzner servers and later
 * drain them; keeping it on the sidecar keeps HCloud and SSH credentials out of
 * the Worker runtime.
 */

import { verifyCronSecret } from "@/lib/api/cron-auth";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { forwardCronToContainerControlPlane } from "../../_container-control-plane-forward";

async function handleAutoscale(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(c.req.raw, "[Node Autoscale]", env);
  if (authError) return authError;
  return forwardCronToContainerControlPlane(c);
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => handleAutoscale(c, c.env));
__hono_app.post("/", async (c) => handleAutoscale(c, c.env));
export default __hono_app;

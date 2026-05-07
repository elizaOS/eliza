import { Hono } from "hono";
import { verifyCronSecret } from "@/lib/api/cron-auth";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { forwardCronToContainerControlPlane } from "../../_container-control-plane-forward";

/**
 * Warm pool replenisher cron. Forwards to the Node container control
 * plane, which can SSH into Hetzner nodes and start new pool containers.
 */
async function handle(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(c.req.raw, "[Pool Replenish]", env);
  if (authError) return authError;
  return forwardCronToContainerControlPlane(c);
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => handle(c, c.env));
__hono_app.post("/", async (c) => handle(c, c.env));
export default __hono_app;

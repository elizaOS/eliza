import { Hono } from "hono";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

/**
 * Agent hot-pool cron handler.
 *
 * Keeps the shared Hetzner-Docker agent path warm by forwarding to the Node
 * container control plane, which can safely use SSH to pre-pull the current
 * agent image on healthy nodes with spare capacity.
 */

import { verifyCronSecret } from "@/lib/auth/cron";
import { forwardCronToContainerControlPlane } from "../../_container-control-plane-forward";

async function handleAgentHotPool(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(c.req.raw, "[Agent Hot Pool]", env);
  if (authError) return authError;
  return forwardCronToContainerControlPlane(c);
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => handleAgentHotPool(c, c.env));
__hono_app.post("/", async (c) => handleAgentHotPool(c, c.env));
export default __hono_app;

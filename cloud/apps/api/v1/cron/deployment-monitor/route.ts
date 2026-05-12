import { Hono } from "hono";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

/**
 * Deployment monitor cron handler.
 *
 * Polls in-flight Hetzner-Docker containers (status `deploying`) and
 * flips them to `running` once the Docker container reports healthy or
 * to `failed` once it exits/dies. Runs every minute.
 *
 * The Docker monitor itself is Node-only (transitively imports `ssh2`), so
 * this Worker route validates cron auth and forwards to the container control
 * plane sidecar.
 */

import { verifyCronSecret } from "@/lib/auth/cron";
import { forwardCronToContainerControlPlane } from "../../_container-control-plane-forward";

async function handleDeploymentMonitor(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(c.req.raw, "[Deployment Monitor]", env);
  if (authError) return authError;
  return forwardCronToContainerControlPlane(c);
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => handleDeploymentMonitor(c, c.env));
__hono_app.post("/", async (c) => handleDeploymentMonitor(c, c.env));
export default __hono_app;

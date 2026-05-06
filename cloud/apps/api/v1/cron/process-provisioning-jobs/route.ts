/**
 * /api/v1/cron/process-provisioning-jobs
 * Claims and executes pending provisioning jobs from the `jobs` table.
 *
 * The actual processor is Node-only because agent provisioning uses SSH and
 * Docker-node management. Cloudflare Workers validate cron auth here and
 * forward the call to the container control-plane sidecar.
 */

import { Hono } from "hono";
import { verifyCronSecret } from "@/lib/api/cron-auth";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { forwardCronToContainerControlPlane } from "../../_container-control-plane-forward";

async function handleProcessProvisioningJobs(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(c.req.raw, "[Provisioning Jobs]", env);
  if (authError) return authError;
  return forwardCronToContainerControlPlane(c);
}

const app = new Hono<AppEnv>();
app.get("/", async (c) => handleProcessProvisioningJobs(c, c.env));
app.post("/", async (c) => handleProcessProvisioningJobs(c, c.env));

export default app;

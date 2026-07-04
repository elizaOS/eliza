// Handles v1 cloud API node disk retention route traffic with route-local auth expectations.
import { Hono } from "hono";
import { verifyCronSecret } from "@/lib/auth/cron";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { cronSupersededByDaemon } from "../../_container-control-plane-forward";

/**
 * Node disk-cleanup cron. The actual work (df check + prune of stuck containerd
 * ingest / dangling images on HEALTHY nodes) is driven by the provisioning-worker
 * daemon's infra-maintenance cycle (`processNodeDiskCleanupCycle`), which owns the
 * SSH credential and docker_nodes truth. This CF cron only validates auth and
 * acknowledges so the schedule has a parity endpoint instead of a dead forward.
 */
async function handle(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(c.req.raw, "[Node Disk Cleanup]", env);
  if (authError) return authError;
  return cronSupersededByDaemon(c, "processNodeDiskCleanupCycle");
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => handle(c, c.env));
__hono_app.post("/", async (c) => handle(c, c.env));
export default __hono_app;

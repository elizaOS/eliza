import { Hono } from "hono";
import { verifyCronSecret } from "@/lib/auth/cron";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

/**
 * Scheduled-backups cron.
 *
 * Enqueues an `auto` snapshot for every running agent whose last backup has
 * aged past the interval. Runs in-worker (a DB write) rather than forwarding
 * to the container control plane — the snapshot jobs it creates are picked up
 * by the regular provisioning worker, which has bridge access to pull state.
 * Retention is enforced by `pruneBackups` inside the snapshot handler.
 *
 * Tunables via query string: `?intervalMs=<n>&max=<n>`.
 */
async function handle(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(c.req.raw, "[Agent Backups]", env);
  if (authError) return authError;

  const url = new URL(c.req.url);
  const intervalMs = Number(url.searchParams.get("intervalMs"));
  const max = Number(url.searchParams.get("max"));

  const result = await provisioningJobService.enqueueScheduledBackups({
    minIntervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : undefined,
    maxAgents: Number.isFinite(max) && max > 0 ? max : undefined,
  });

  logger.info("[Agent Backups] Scheduled backup sweep complete", result);
  return c.json({ success: true, ...result });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => handle(c, c.env));
__hono_app.post("/", async (c) => handle(c, c.env));
export default __hono_app;

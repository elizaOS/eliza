import { Hono } from "hono";
import { verifyCronSecret } from "@/lib/auth/cron";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { cronSupersededByDaemon } from "../../_container-control-plane-forward";

/**
 * Warm pool replenisher cron. Work has been folded into the
 * eliza-provisioning-worker daemon's own maintenance cycle.
 */
async function handle(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(c.req.raw, "[Pool Replenish]", env);
  if (authError) return authError;
  return cronSupersededByDaemon(c, "runInfraMaintenanceCycle (warm pool)");
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => handle(c, c.env));
__hono_app.post("/", async (c) => handle(c, c.env));
export default __hono_app;

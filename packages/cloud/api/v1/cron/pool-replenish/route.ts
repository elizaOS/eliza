// Handles v1 cloud API v1 cron pool replenish route traffic with route-local auth expectations.

import { verifyCronSecret } from "@elizaos/cloud-shared/lib/auth/cron";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { cronSupersededByDaemon } from "../../_container-control-plane-forward";

/**
 * Warm pool replenisher cron. Work now runs in the eliza-provisioning-worker
 * daemon's `runInfraMaintenanceCycle` as the "warm pool replenish cycle" phase
 * (`processPoolReplenishCycle` -> `WarmPoolManager.replenish`), fired after the
 * node-health/autoscale/drain phases so it refills against fresh capacity.
 *
 * NOTE: this stub previously named the phase but no such phase existed — the
 * daemon only wired `drainIdle`, so the pool never refilled and every create
 * degraded to the cold path once the pool drained. The phase is now real; this
 * label is accurate.
 */
async function handle(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(c.req.raw, "[Pool Replenish]", env);
  if (authError) return authError;
  return cronSupersededByDaemon(
    c,
    "runInfraMaintenanceCycle (warm pool replenish cycle)",
  );
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => handle(c, c.env));
__hono_app.post("/", async (c) => handle(c, c.env));
export default __hono_app;

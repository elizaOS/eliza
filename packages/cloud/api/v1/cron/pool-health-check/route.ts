// Handles v1 cloud API v1 cron pool health check route traffic with route-local auth expectations.
import { Hono } from "hono";
import { verifyCronSecret } from "@/lib/auth/cron";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { cronSupersededByDaemon } from "../../_container-control-plane-forward";

/** Warm pool health-check cron. Probes each pool entry; reaps dead/stuck rows. */
async function handle(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(c.req.raw, "[Pool Health Check]", env);
  if (authError) return authError;
  return cronSupersededByDaemon(c, "processNodeHealthCheckCycle");
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => handle(c, c.env));
__hono_app.post("/", async (c) => handle(c, c.env));
export default __hono_app;

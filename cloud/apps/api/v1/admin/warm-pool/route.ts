import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { requireAdmin } from "@/lib/auth";
import { containersEnv } from "@/lib/config/containers-env";
import {
  computeForecast,
  DEFAULT_WARM_POOL_POLICY,
} from "@/lib/services/containers/agent-warm-pool-forecast";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Admin: warm pool state for the infrastructure dashboard.
 *
 * Read-only — pool sizing decisions are made by the cron handlers in the
 * control-plane. This endpoint surfaces just enough for operators to see:
 *   • current pool size (ready + provisioning)
 *   • policy (min/max)
 *   • forecast input + recommendation
 *   • whether the pool is enabled
 *
 * Lives in the worker so the dashboard doesn't need control-plane
 * connectivity.
 */
async function __hono_GET(request: Request) {
  const { role } = await requireAdmin(request);
  if (role !== "super_admin") {
    return Response.json({ success: false, error: "Super admin access required" }, { status: 403 });
  }

  try {
    const enabled = containersEnv.warmPoolEnabled();
    const minPoolSize = containersEnv.warmPoolMinSize();
    const maxPoolSize = containersEnv.warmPoolMaxSize();
    const image = containersEnv.defaultAgentImage();

    const counts = await agentSandboxesRepository.countAllPoolEntries();
    const onCurrentImage = await agentSandboxesRepository.countUnclaimedPool({ image });
    const buckets = await agentSandboxesRepository.countUserProvisionsByHour(
      DEFAULT_WARM_POOL_POLICY.forecastWindowHours,
    );
    const forecast = computeForecast({
      bucketCounts: buckets,
      emaAlpha: DEFAULT_WARM_POOL_POLICY.emaAlpha,
      leadTimeBuckets: DEFAULT_WARM_POOL_POLICY.leadTimeBuckets,
      minPoolSize,
      maxPoolSize,
    });

    return Response.json({
      success: true,
      data: {
        enabled,
        minPoolSize,
        maxPoolSize,
        image,
        size: {
          ready: counts.ready,
          provisioning: counts.provisioning,
          onCurrentImage,
          stale: Math.max(0, counts.ready - onCurrentImage),
        },
        forecast: {
          bucketsHourly: buckets,
          predictedRate: forecast.predictedRate,
          targetPoolSize: forecast.targetPoolSize,
        },
        policy: {
          forecastWindowHours: DEFAULT_WARM_POOL_POLICY.forecastWindowHours,
          emaAlpha: DEFAULT_WARM_POOL_POLICY.emaAlpha,
          idleScaleDownMs: DEFAULT_WARM_POOL_POLICY.idleScaleDownMs,
          replenishBurstLimit: DEFAULT_WARM_POOL_POLICY.replenishBurstLimit,
        },
      },
    });
  } catch (error) {
    logger.error("[admin/warm-pool] failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to read warm pool state",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw));
export default __hono_app;

/**
 * /api/v1/cron/provisioning-worker-health
 * Cron job that observes the provisioning-worker daemon heartbeat and, when it
 * is stale/absent, alerts ops (structured error log + configured channels).
 * The daemon cannot page about its own death, so this runs separately on the
 * Worker. Schedule: every minute (registered in CRON_FANOUT for "* * * * *"
 * alongside health-check and deployment-monitor).
 *
 * Also runs the dedicated-fleet liveness monitor (#22548): "dedicated agents
 * exist and none is serving" is invisible to the heartbeat sweep (which
 * iterates only running rows), so this cron asks it explicitly and publishes
 * provisioning success measured on the jobs ledger in its response and logs.
 *
 * The two monitors are INDEPENDENT questions that merely share a schedule, so
 * they are settled independently: a Redis outage in the heartbeat gate, or a
 * database outage in the fleet census, must not silence the sibling monitor —
 * that would recreate the exact silence this cron exists to prevent, at the
 * exact moment one monitoring dependency is unhealthy. Each failure is logged
 * under its own scope and the cron still answers with a structured failure so
 * the schedule itself is visibly red.
 *
 * Protected by CRON_SECRET; supports GET (Workers cron trigger) and POST (manual hits).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import {
  type DedicatedFleetLiveness,
  monitorDedicatedFleetLiveness,
} from "@/lib/services/dedicated-fleet-liveness";
import { monitorProvisioningWorkerHealth } from "@/lib/services/provisioning-worker-health-monitor";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runProvisioningWorkerHealthCheck(c: AppContext) {
  try {
    requireCronSecret(c);
  } catch (error) {
    // error-policy:J1 transport boundary — an unauthenticated cron hit is a
    // structured 4xx, and neither monitor may run.
    return failureResponse(c, error);
  }

  const [heartbeatResult, fleetResult] = await Promise.allSettled([
    monitorProvisioningWorkerHealth(),
    monitorDedicatedFleetLiveness(),
  ]);

  const failures: string[] = [];

  if (heartbeatResult.status === "rejected") {
    failures.push("provisioning-worker-heartbeat");
    logger.error(
      "[Provisioning Worker Health Cron] Heartbeat monitor failed:",
      describe(heartbeatResult.reason),
    );
  }
  if (fleetResult.status === "rejected") {
    failures.push("dedicated-fleet-liveness");
    logger.error(
      "[Provisioning Worker Health Cron] Dedicated-fleet liveness monitor failed:",
      describe(fleetResult.reason),
    );
  }

  const fleet: DedicatedFleetLiveness | null =
    fleetResult.status === "fulfilled" ? fleetResult.value : null;
  const heartbeat =
    heartbeatResult.status === "fulfilled" ? heartbeatResult.value : null;

  logger.info("[Provisioning Worker Health Cron] Monitors settled", {
    heartbeatOk: heartbeatResult.status === "fulfilled",
    fleetOk: fleetResult.status === "fulfilled",
    healthy: heartbeat?.healthy ?? null,
    stale: heartbeat?.stale ?? null,
    required: heartbeat?.health.required ?? null,
    fleetExpectedReachable: fleet?.expectedReachableTotal ?? null,
    fleetExpectedReachableRunning: fleet?.expectedReachableRunning ?? null,
    fleetUnreachable: fleet?.unreachable ?? null,
    fleetOffContract: fleet?.offContractTotal ?? null,
    provisionSuccessRate: fleet?.provisionSuccessRate ?? null,
  });

  const monitors = {
    heartbeat:
      heartbeatResult.status === "fulfilled"
        ? { ok: true as const }
        : { ok: false as const, error: describe(heartbeatResult.reason) },
    fleet:
      fleetResult.status === "fulfilled"
        ? { ok: true as const }
        : { ok: false as const, error: describe(fleetResult.reason) },
  };

  // `!heartbeat` is implied by a non-empty `failures`; it is spelled out so the
  // destructure below is narrowed by control flow rather than by an assertion.
  if (failures.length > 0 || !heartbeat) {
    return c.json(
      {
        success: false,
        error: `Cron monitor(s) failed: ${failures.join(", ")}`,
        code: "cron_monitor_failed" as const,
        monitors,
        ...(heartbeat ?? {}),
        fleet,
      },
      500,
    );
  }

  const { healthy, stale, health } = heartbeat;
  return c.json({ healthy, stale, health, fleet, monitors });
}

app.get("/", runProvisioningWorkerHealthCheck);
app.post("/", runProvisioningWorkerHealthCheck);

export default app;

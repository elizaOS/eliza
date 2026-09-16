/**
 * Exposes the scheduler-only boundary for V3 periodic-backup admission.
 *
 * The route composes primary-database admission authorities only. It never
 * captures a sandbox, provisions capacity, invokes a provider, or autoscales.
 * An exact deployment binding keeps the caller dormant until activation is
 * explicitly authorized and the downstream backup executor is ready.
 */

import { Hono } from "hono";
import { verifyCronSecret } from "@/lib/auth/cron";
import {
  getScheduledCronInvocationMetadata,
  scheduledCronInvocationId,
} from "@/lib/cron/cloudflare-cron";
import { runAgentBackupAdmissionCycle } from "@/lib/services/agent-backup-admission-runtime";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

export const AGENT_BACKUP_ADMISSION_CALLER_PATH =
  "/api/v1/cron/agent-backup-admission";
export const AGENT_BACKUP_ADMISSION_CALLER_SCHEDULE = "* * * * *";

export interface AgentBackupAdmissionCronDependencies {
  run: typeof runAgentBackupAdmissionCycle;
}

const productionDependencies: AgentBackupAdmissionCronDependencies = {
  run: runAgentBackupAdmissionCycle,
};

interface ScheduledAdmissionIdentity {
  invocationId: string;
  ownerId: string;
  scheduledTime: number;
}

function scheduledAdmissionIdentity(
  request: Request,
): ScheduledAdmissionIdentity | null {
  const metadata = getScheduledCronInvocationMetadata(request);
  if (
    metadata === null ||
    metadata.path !== AGENT_BACKUP_ADMISSION_CALLER_PATH ||
    metadata.schedule !== AGENT_BACKUP_ADMISSION_CALLER_SCHEDULE ||
    new URL(request.url).pathname !== AGENT_BACKUP_ADMISSION_CALLER_PATH ||
    !Number.isSafeInteger(metadata.scheduledTime) ||
    metadata.scheduledTime < 0 ||
    !Number.isFinite(new Date(metadata.scheduledTime).getTime())
  ) {
    return null;
  }

  const expectedInvocationId = scheduledCronInvocationId(
    {
      cron: AGENT_BACKUP_ADMISSION_CALLER_SCHEDULE,
      scheduledTime: metadata.scheduledTime,
    },
    AGENT_BACKUP_ADMISSION_CALLER_PATH,
  );
  if (metadata.invocationId !== expectedInvocationId) return null;

  return {
    invocationId: expectedInvocationId,
    ownerId: `agent-backup-admission:${metadata.scheduledTime}`,
    scheduledTime: metadata.scheduledTime,
  };
}

export function createAgentBackupAdmissionCronRoute(
  dependencies: AgentBackupAdmissionCronDependencies = productionDependencies,
) {
  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    const authError = verifyCronSecret(
      c.req.raw,
      "[Agent Backup Admission]",
      c.env,
    );
    if (authError) return authError;

    const identity = scheduledAdmissionIdentity(c.req.raw);
    if (identity === null) {
      logger.warn(
        "[Agent Backup Admission] Rejected request without exact scheduler provenance",
      );
      return c.json(
        { success: false, error: "Internal scheduler provenance required" },
        403,
      );
    }

    if (c.env.AGENT_BACKUP_ADMISSION_CALLER_ENABLED !== "1") {
      return c.json({
        success: true,
        enabled: false,
        invocationId: identity.invocationId,
        scheduledTime: identity.scheduledTime,
      });
    }

    try {
      const summary = await dependencies.run({
        ownerId: identity.ownerId,
        scheduledTime: identity.scheduledTime,
        signal: c.req.raw.signal,
      });
      const fields = {
        invocationId: identity.invocationId,
        scheduledTime: identity.scheduledTime,
        ...summary,
      };
      if (summary.alerts.length > 0) {
        logger.warn(
          "[Agent Backup Admission] Caller completed with alerts",
          fields,
        );
      } else {
        logger.info("[Agent Backup Admission] Caller completed", fields);
      }
      return c.json({ success: true, enabled: true, ...fields });
    } catch (error) {
      logger.error("[Agent Backup Admission] Caller failed", {
        invocationId: identity.invocationId,
        scheduledTime: identity.scheduledTime,
        error,
      });
      // error-policy:J1 translate the scheduler route boundary to an explicit failure.
      return c.json(
        { success: false, error: "Backup admission caller failed" },
        500,
      );
    }
  });

  return app;
}

export default createAgentBackupAdmissionCronRoute();

/**
 * GET /api/v1/jobs/:jobId
 * Poll the status of an async provisioning job.
 *
 * Auth: X-Service-Key (service-to-service) OR user auth / API key.
 * Job must belong to the caller's organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { validateServiceKey } from "@/lib/auth/service-key-hono-worker";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getConfiguredElizaAgentPublicWebUiUrl } from "@/lib/eliza-agent-web-ui";
import { publicJobErrorSummary } from "@/lib/services/job-error-text";
import { JOB_TYPES } from "@/lib/services/provisioning-job-types";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const OWNER_INTERNAL_RESULT_KEYS = new Set([
  "bridgeUrl",
  "bridge_url",
  "containerUrl",
  "container_url",
  "healthUrl",
  "health_url",
  "headscaleIp",
  "headscale_ip",
  "internalBridgeUrl",
  "internal_bridge_url",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeOwnerJobResult(
  value: unknown,
  canonicalAgentBaseDomain: string | undefined,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeOwnerJobResult(item, canonicalAgentBaseDomain),
    );
  }
  if (!isRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (OWNER_INTERNAL_RESULT_KEYS.has(key)) continue;
    sanitized[key] = sanitizeOwnerJobResult(item, canonicalAgentBaseDomain);
  }

  const agentId =
    typeof value.cloudAgentId === "string"
      ? value.cloudAgentId
      : typeof value.agentId === "string"
        ? value.agentId
        : null;
  if (agentId) {
    sanitized.webUiUrl = getConfiguredElizaAgentPublicWebUiUrl(
      { id: agentId },
      canonicalAgentBaseDomain,
    );
  }

  return sanitized;
}

app.get("/", async (c) => {
  try {
    let organizationId: string | null = null;

    const serviceIdentity = await validateServiceKey(c);
    if (serviceIdentity) {
      // Service-key callers orchestrate jobs on behalf of wallet-owned agents,
      // so their job rows may belong to the agent owner org rather than the
      // service org configured on the key.
      organizationId = null;
    } else {
      const user = await requireUserOrApiKeyWithOrg(c);
      organizationId = user.organization_id;
    }

    const jobId = c.req.param("jobId");
    if (!jobId) {
      return c.json({ success: false, error: "Job ID is required" }, 400);
    }

    const job = organizationId
      ? await provisioningJobService.getJobForOrg(jobId, organizationId)
      : await provisioningJobService.getJob(jobId);

    if (!job) {
      return c.json({ success: false, error: "Job not found" }, 404);
    }
    if (!serviceIdentity && job.type === JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE) {
      return c.json({ success: false, error: "Job not found" }, 404);
    }

    return c.json({
      success: true,
      data: {
        id: job.id,
        type: job.type,
        status: job.status,
        result: serviceIdentity
          ? job.result
          : sanitizeOwnerJobResult(
              job.result,
              c.env?.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
            ),
        // Operator diagnostic stays in the row; the owner gets the failure
        // summary without stack frames (server paths, module layout).
        error: publicJobErrorSummary(job.error),
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        estimatedCompletionAt: job.estimated_completion_at,
        scheduledFor: job.scheduled_for,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      },
      polling:
        job.status === "pending" || job.status === "in_progress"
          ? { intervalMs: 5000, shouldContinue: true }
          : { shouldContinue: false },
    });
  } catch (error) {
    logger.error("[Jobs API] Error fetching job:", error);
    return failureResponse(c, error);
  }
});

export default app;

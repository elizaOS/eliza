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
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    let organizationId: string;

    const serviceIdentity = await validateServiceKey(c);
    if (serviceIdentity) {
      organizationId = serviceIdentity.organizationId;
    } else {
      const user = await requireUserOrApiKeyWithOrg(c);
      organizationId = user.organization_id;
    }

    const jobId = c.req.param("jobId");
    if (!jobId) {
      return c.json({ success: false, error: "Job ID is required" }, 400);
    }

    const job = await provisioningJobService.getJobForOrg(jobId, organizationId);

    if (!job) {
      return c.json({ success: false, error: "Job not found" }, 404);
    }

    return c.json({
      success: true,
      data: {
        id: job.id,
        type: job.type,
        status: job.status,
        result: job.result,
        error: job.error,
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

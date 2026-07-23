/**
 * Exposes the super-admin-only dry-run and execute boundary for named agent
 * image canaries. The request cannot choose audit identity, rollout IDs, or
 * rollback image pairs; those are resolved server-side from primary state.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  ForbiddenError,
  failureResponse,
  NotFoundError,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { adminAgentImageRolloutService } from "@/lib/services/admin-agent-image-rollout";
import { JOB_TYPES } from "@/lib/services/provisioning-job-types";
import {
  provisioningJobService,
  readAdminCanaryImageJobData,
} from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const targetSchema = z
  .object({
    agentId: z.string().uuid(),
    organizationId: z.string().uuid(),
    expectedSourceImage: z.string().min(1),
    expectedSourceDigest: digestSchema,
  })
  .strict();
const upgradeSchema = z
  .object({
    operation: z.literal("upgrade"),
    dryRun: z.boolean(),
    targetImage: z.string().min(1),
    targets: z.array(targetSchema).min(1).max(5),
  })
  .strict();
const rollbackSchema = z
  .object({
    operation: z.literal("rollback"),
    dryRun: z.boolean(),
    source: z
      .object({
        rolloutId: z.string().uuid().optional(),
        jobId: z.string().uuid().optional(),
      })
      .strict()
      .refine((source) => Boolean(source.rolloutId) !== Boolean(source.jobId), {
        message: "source must contain exactly one of rolloutId or jobId",
      }),
  })
  .strict();
const requestSchema = z.discriminatedUnion("operation", [
  upgradeSchema,
  rollbackSchema,
]);

interface AdminAgentImageCanaryRouteDependencies {
  requireAdmin: typeof requireAdmin;
  rolloutService: Pick<
    typeof adminAgentImageRolloutService,
    "previewOrEnqueue"
  >;
  jobService: Pick<
    typeof provisioningJobService,
    "getJob" | "triggerImmediate"
  >;
  logger: Pick<typeof logger, "info" | "warn">;
}

const defaultDependencies: AdminAgentImageCanaryRouteDependencies = {
  requireAdmin,
  rolloutService: adminAgentImageRolloutService,
  jobService: provisioningJobService,
  logger,
};

export function createAdminAgentImageCanaryRoute(
  dependencies: AdminAgentImageCanaryRouteDependencies = defaultDependencies,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    try {
      const { user, role } = await dependencies.requireAdmin(c);
      if (role !== "super_admin") {
        throw ForbiddenError("Super admin access required");
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        // error-policy:J3 Malformed transport input is an explicit validation failure.
        throw ValidationError("Request body must be valid JSON");
      }
      const input = requestSchema.parse(body);
      const result = await dependencies.rolloutService.previewOrEnqueue(
        input,
        user.id,
      );

      if (!result.dryRun) {
        // error-policy:J5 Observe the nudge rejection here; the durable cron queue remains authoritative.
        void dependencies.jobService.triggerImmediate(c.env).catch((error) => {
          dependencies.logger.warn(
            "[admin-agent-image-canary] Immediate worker trigger failed",
            {
              rolloutId: result.rolloutId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        });
      }

      dependencies.logger.info(
        "[admin-agent-image-canary] Canary decision accepted",
        {
          actorUserId: user.id,
          operation: result.operation,
          dryRun: result.dryRun,
          rolloutId: result.rolloutId,
          targetCount: result.targets.length,
        },
      );

      return c.json(
        {
          success: true,
          data: result,
          ...(result.dryRun
            ? {}
            : {
                polling: result.targets.map((target) => ({
                  agentId: target.agentId,
                  jobId: target.jobId,
                  endpoint: `/api/v1/admin/agent-image-canary/jobs/${target.jobId}`,
                  intervalMs: 5_000,
                  expectedDurationMs: 180_000,
                })),
              }),
        },
        result.dryRun ? 200 : 202,
      );
    } catch (error) {
      // error-policy:J1 Translate route failures into the canonical API envelope.
      return failureResponse(c, error);
    }
  });

  app.get("/jobs/:jobId", async (c) => {
    try {
      const { user, role } = await dependencies.requireAdmin(c);
      if (role !== "super_admin") {
        throw ForbiddenError("Super admin access required");
      }

      const jobId = c.req.param("jobId");
      const parsedJobId = z.string().uuid().safeParse(jobId);
      if (!parsedJobId.success) {
        throw ValidationError("jobId must be a UUID");
      }

      const job = await dependencies.jobService.getJob(parsedJobId.data);
      if (
        !job ||
        job.type !== JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE ||
        job.user_id !== user.id
      ) {
        throw NotFoundError("Canary image job not found");
      }

      const data = readAdminCanaryImageJobData(job);
      if (
        data.actorUserId !== user.id ||
        data.userId !== user.id ||
        data.organizationId !== job.organization_id ||
        data.agentId !== job.agent_id
      ) {
        throw new Error(
          `Admin canary job ${job.id} has inconsistent actor or target identity`,
        );
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
            ? { intervalMs: 5_000, shouldContinue: true }
            : { shouldContinue: false },
      });
    } catch (error) {
      // error-policy:J1 Translate route failures into the canonical API envelope.
      return failureResponse(c, error);
    }
  });

  return app;
}

export default createAdminAgentImageCanaryRoute();

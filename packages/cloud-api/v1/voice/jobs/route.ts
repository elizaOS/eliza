import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Voice Jobs API (v1)
 *
 * GET /api/v1/voice/jobs
 * Gets all active voice cloning jobs.
 * Supports both session and API key authentication.
 *
 * WHY THIS EXISTS:
 * ----------------
 * 1. ASYNC JOB MONITORING: Voice cloning (especially professional quality) takes time.
 *    This endpoint lets applications poll for completion status programmatically.
 *
 * 2. WORKFLOW INTEGRATION: CI/CD pipelines and automated workflows need to wait for
 *    voice cloning to complete before proceeding to next steps (e.g., deploying
 *    an agent with a newly cloned voice).
 *
 * 3. ERROR HANDLING: Applications can detect failed jobs and implement retry logic
 *    or alert users about quality issues with their audio samples.
 */

import { getErrorStatusCode, nextJsonFromCaughtError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { voiceCloningService } from "@/lib/services/voice-cloning";
import { logger } from "@/lib/utils/logger";

/**
 * GET /api/v1/voice/jobs
 * Gets all active (processing or pending) voice cloning jobs for the authenticated user.
 * Only returns jobs that are still in progress.
 *
 * @param request - The Next.js request object.
 * @returns Array of active voice cloning jobs with status and progress information.
 */
async function __hono_GET(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    logger.info(`[Voice Jobs API] Fetching jobs for user ${user.id}`);

    const allJobs = await voiceCloningService.getUserJobs(user.organization_id, user.id);

    const activeJobs = allJobs.filter(
      (job) => job.status === "processing" || job.status === "pending",
    );

    return Response.json({
      success: true,
      jobs: activeJobs.map((job) => ({
        id: job.id,
        voiceName: job.voiceName,
        jobType: job.jobType,
        status: job.status,
        progress: job.progress,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
      })),
      total: activeJobs.length,
    });
  } catch (error) {
    if (getErrorStatusCode(error) >= 500) {
      logger.error("[Voice Jobs API] Error:", error);
    }
    return nextJsonFromCaughtError(error);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw));
export default __hono_app;

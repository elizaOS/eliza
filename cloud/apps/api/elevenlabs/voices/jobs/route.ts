import { Hono } from "hono";
import { getErrorStatusCode, nextJsonFromCaughtError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { voiceCloningService } from "@/lib/services/voice-cloning";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET /api/elevenlabs/voices/jobs
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

    // Get user's jobs (only in-progress ones)
    const allJobs = await voiceCloningService.getUserJobs(user.organization_id!, user.id);

    // Filter for only processing/pending jobs
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

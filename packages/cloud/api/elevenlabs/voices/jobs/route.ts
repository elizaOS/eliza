// Handles cloud API elevenlabs voices jobs route traffic with route-local auth expectations.
import { Hono } from "hono";
import { getErrorStatusCode, nextJsonFromCaughtError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { exposedVoiceCloneFailureReason } from "@/lib/services/voice-clone-failure";
import { voiceCloningService } from "@/lib/services/voice-cloning";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET /api/elevenlabs/voices/jobs
 * Gets active and reconciliation-required voice cloning jobs for the authenticated user.
 *
 * @param request - The Next.js request object.
 * @returns Array of active voice cloning jobs with status and progress information.
 */
async function __hono_GET(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    logger.info(`[Voice Jobs API] Fetching jobs for user ${user.id}`);

    // Get user's jobs (only in-progress ones)
    const allJobs = await voiceCloningService.getUserJobs(
      user.organization_id!,
      user.id,
    );

    // Reconciliation-required jobs stay visible as an explicit manual queue;
    // they must never disappear as ordinary failures after ambiguous provider work.
    const activeJobs = allJobs.filter(
      (job) =>
        job.status === "processing" ||
        job.status === "pending" ||
        job.status === "reconciliation_required",
    );

    return Response.json({
      success: true,
      jobs: activeJobs.map((job) => {
        const metadata = job.metadata as Record<string, unknown>;
        const providerState =
          typeof metadata.providerSubmissionState === "string"
            ? metadata.providerSubmissionState
            : null;
        const providerStep =
          typeof metadata.providerLastStep === "string"
            ? metadata.providerLastStep
            : null;
        return {
          id: job.id,
          voiceName: job.voiceName,
          jobType: job.jobType,
          status: job.status,
          progress: job.progress,
          errorMessage: exposedVoiceCloneFailureReason(
            job.errorMessage,
            job.status === "reconciliation_required",
          ),
          reconciliationRequired: job.status === "reconciliation_required",
          providerState,
          providerStep,
          providerVoiceId: job.elevenlabsVoiceId,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
        };
      }),
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

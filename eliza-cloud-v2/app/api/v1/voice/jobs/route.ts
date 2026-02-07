/**
 * Voice Jobs API (v1)
 *
 * GET /api/v1/voice/jobs
 * Gets all active voice cloning jobs.
 * Supports both Privy session and API key authentication.
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

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
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
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    logger.info(`[Voice Jobs API] Fetching jobs for user ${user.id}`);

    const allJobs = await voiceCloningService.getUserJobs(
      user.organization_id,
      user.id,
    );

    const activeJobs = allJobs.filter(
      (job) => job.status === "processing" || job.status === "pending",
    );

    return NextResponse.json({
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
    logger.error("[Voice Jobs API] Error:", error);

    if (error instanceof Error && error.message.includes("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      { error: "Failed to fetch voice jobs. Please try again." },
      { status: 500 },
    );
  }
}

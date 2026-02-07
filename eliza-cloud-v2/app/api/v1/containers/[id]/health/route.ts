import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { getContainerHealthStatus } from "@/lib/services/health-monitor";
import { containersRepository } from "@/db/repositories/containers";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/containers/[id]/health
 * Performs a health check on a container by making an HTTP request to its health endpoint.
 *
 * @param request - The Next.js request object.
 * @param params - Route parameters containing the container ID.
 * @returns Health status including response time, status code, and error information.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id: containerId } = await params;

    // Verify container belongs to user's organization
    const container = await containersRepository.findById(
      containerId,
      user.organization_id!,
    );

    if (!container) {
      return NextResponse.json(
        {
          success: false,
          error: "Container not found",
        },
        { status: 404 },
      );
    }

    // Perform health check
    const healthStatus = await getContainerHealthStatus(containerId);

    if (!healthStatus) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Unable to perform health check - container may not have a URL",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        containerId: healthStatus.containerId,
        healthy: healthStatus.healthy,
        statusCode: healthStatus.statusCode,
        responseTime: healthStatus.responseTime,
        error: healthStatus.error,
        checkedAt: healthStatus.checkedAt,
        containerStatus: container.status,
        lastHealthCheck: container.last_health_check,
      },
    });
  } catch (error) {
    logger.error("Error checking container health:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to check container health",
      },
      { status: 500 },
    );
  }
}

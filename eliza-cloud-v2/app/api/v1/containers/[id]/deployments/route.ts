import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { containersService } from "@/lib/services/containers";
import { usageRecordsRepository } from "@/db/repositories/usage-records";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/containers/[id]/deployments
 * Retrieves deployment history for a specific container from usage records.
 *
 * @param request - The Next.js request object.
 * @param params - Route parameters containing the container ID.
 * @returns Deployment history with status, costs, and metadata.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    // Verify container belongs to user's organization
    const container = await containersService.getById(
      id,
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

    // Get deployment history from usage records
    // Note: This needs a custom query since we're filtering by type and metadata
    // For now, we'll use the repository's list method and filter in memory
    // A better approach would be to add a specific repository method for this
    const allRecords = await usageRecordsRepository.listByOrganization(
      user.organization_id!,
      50,
    );

    // Filter for container deployments
    const deployments = allRecords.filter(
      (record) => record.type === "container_deployment",
    );

    // Filter for this specific container
    interface DeploymentMetadata {
      container_id?: string;
      container_name?: string;
      desired_count?: string;
      cpu?: string;
      memory?: string;
      port?: string;
    }

    const containerDeployments = deployments.filter((d) => {
      const metadata = (d.metadata as DeploymentMetadata | null) ?? {};
      return (
        metadata.container_id === id ||
        metadata.container_name === container.name
      );
    });

    // Enhance with container status snapshots
    // Status logic:
    // - is_successful: true → "success"
    // - is_successful: false && error_message → "failed"
    // - is_successful: false && no error_message → "pending" (deployment in progress)
    const enhancedHistory = containerDeployments.map((deployment) => {
      const metadata = (deployment.metadata as DeploymentMetadata | null) ?? {};

      let status: "success" | "failed" | "pending";
      if (deployment.is_successful) {
        status = "success";
      } else if (deployment.error_message) {
        status = "failed";
      } else {
        status = "pending";
      }

      return {
        id: deployment.id,
        status,
        cost: deployment.input_cost,
        error: deployment.error_message,
        metadata: {
          container_id: metadata.container_id,
          container_name: metadata.container_name,
          desired_count: metadata.desired_count,
          cpu: metadata.cpu,
          memory: metadata.memory,
          port: metadata.port,
          image_tag: container.image_tag,
          ecs_service_arn: container.ecs_service_arn,
        },
        deployed_at: deployment.created_at,
        duration_ms: deployment.duration_ms,
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        container: {
          id: container.id,
          name: container.name,
          current_status: container.status,
          load_balancer_url: container.load_balancer_url,
          ecs_service_arn: container.ecs_service_arn,
        },
        deployments: enhancedHistory,
        total: enhancedHistory.length,
      },
    });
  } catch (error) {
    logger.error("Error fetching deployment history:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch deployment history",
      },
      { status: 500 },
    );
  }
}

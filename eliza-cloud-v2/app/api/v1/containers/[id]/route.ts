/**
 * Production-ready container management endpoints with proper teardown
 *
 * DELETE endpoint now properly tears down CloudFormation stacks
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  getContainer,
  deleteContainer,
  updateContainerStatus,
  containersService,
} from "@/lib/services/containers";
import { cloudFormationService } from "@/lib/services/cloudformation";
import { dbPriorityManager } from "@/lib/services/alb-priority-manager";
import { creditsService } from "@/lib/services/credits";
import { calculateDeploymentCost } from "@/lib/constants/pricing";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/containers/[id]
 * Get container details
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id: containerId } = await params;

    const container = await getContainer(containerId, user.organization_id!);

    if (!container) {
      return NextResponse.json(
        {
          success: false,
          error: "Container not found",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: container,
    });
  } catch (error) {
    logger.error("Error fetching container:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch container",
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/v1/containers/[id]
 * Delete container and tear down CloudFormation stack
 *
 * PRODUCTION READY:
 * - Tears down CloudFormation stack
 * - Releases ALB priority
 * - Refunds remaining credits (prorated)
 * - Cleans up database records
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id: containerId } = await params;

    // Get container details
    const container = await getContainer(containerId, user.organization_id!);

    if (!container) {
      return NextResponse.json(
        {
          success: false,
          error: "Container not found",
        },
        { status: 404 },
      );
    }

    // Check ownership
    if (container.organization_id !== user.organization_id!) {
      return NextResponse.json(
        {
          success: false,
          error: "Unauthorized",
        },
        { status: 403 },
      );
    }

    // Step 1: Update status to deleting
    await updateContainerStatus(containerId, "deleting", {
      deploymentLog: "Teardown initiated...",
    });

    // Step 2: Delete CloudFormation stack
    try {
      await cloudFormationService.deleteUserStack(
        container.organization_id,
        container.project_name,
      );

      // Wait for deletion with timeout
      const DELETION_TIMEOUT_MINUTES = 15;
      await cloudFormationService.waitForStackDeletion(
        container.organization_id,
        container.project_name,
        DELETION_TIMEOUT_MINUTES,
      );
    } catch (cfError) {
      logger.error(`Failed to delete CloudFormation stack:`, cfError);

      // Log error but continue with cleanup
      // Stack may have been manually deleted or may not exist
      await updateContainerStatus(containerId, "deleting", {
        deploymentLog: `Warning: CloudFormation stack deletion failed: ${cfError instanceof Error ? cfError.message : "Unknown error"}`,
      });
    }

    // Step 3: Release ALB priority
    try {
      await dbPriorityManager.releasePriority(
        container.organization_id,
        container.project_name,
      );
    } catch (priorityError) {
      logger.error(`Failed to release ALB priority:`, priorityError);
      // Non-critical - continue with cleanup
    }

    // Step 4: Calculate prorated refund if container was running (daily billing model)
    let refundAmount = 0;

    if (container.status === "running" && container.created_at) {
      try {
        // Calculate how long the container was running
        const now = Date.now();
        const createdAt = new Date(container.created_at).getTime();
        const runtimeHours = (now - createdAt) / (1000 * 60 * 60);
        const runtimeDays = runtimeHours / 24;

        // Calculate deployment cost (one-time fee)
        const deploymentCost = calculateDeploymentCost({
          desiredCount: container.desired_count || 1,
          cpu: container.cpu || 1792,
          memory: container.memory || 1792,
        });

        // Prorated refund for daily billing:
        // - If deleted within 2 hours of deployment, refund 75% of deployment cost
        // - If deleted same day (before first daily billing), refund 50% of deployment cost
        // This is generous to users but prevents abuse
        if (runtimeHours < 2) {
          refundAmount = Math.floor(deploymentCost * 0.75);
        } else if (runtimeDays < 1) {
          refundAmount = Math.floor(deploymentCost * 0.5);
        }

        if (refundAmount > 0) {
          await creditsService.addCredits({
            organizationId: user.organization_id!!,
            amount: refundAmount,
            description: `Prorated refund for container ${container.name} (ran ${runtimeHours.toFixed(2)} hours)`,
            metadata: {
              type: "refund",
              containerId,
              runtimeHours: runtimeHours.toFixed(2),
              runtimeDays: runtimeDays.toFixed(2),
            },
          });
        }
      } catch (refundError) {
        logger.error(`Failed to process refund:`, refundError);
        // Log but don't fail the deletion
      }
    }

    // Step 5: Delete from database
    await deleteContainer(containerId, user.organization_id!);

    return NextResponse.json({
      success: true,
      message: "Container deleted successfully",
      refundAmount: refundAmount > 0 ? refundAmount : undefined,
    });
  } catch (error) {
    logger.error("Error deleting container:", error);

    // Try to update status to failed
    try {
      const { id } = await params;
      await updateContainerStatus(id, "failed", {
        errorMessage: "Deletion failed",
        deploymentLog: `Deletion error: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    } catch {
      // Ignore status update errors
    }

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to delete container",
      },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/v1/containers/[id]
 * Update container configuration via CloudFormation stack update
 *
 * Updatable parameters:
 * - cpu: Container CPU units (256-2048)
 * - memory: Container memory in MB (512-2048)
 * - ecr_image_uri: New Docker image URI
 * - port: Container port (1-65535)
 *
 * Note: Updates trigger a CloudFormation stack update which takes 5-10 minutes
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id: containerId } = await params;
    const body = await request.json();

    // Get container
    const container = await getContainer(containerId, user.organization_id!);

    if (!container) {
      return NextResponse.json(
        {
          success: false,
          error: "Container not found",
        },
        { status: 404 },
      );
    }

    // Check ownership
    if (container.organization_id !== user.organization_id!) {
      return NextResponse.json(
        {
          success: false,
          error: "Unauthorized",
        },
        { status: 403 },
      );
    }

    // Validate and extract updateable parameters
    const updates: {
      containerImage?: string;
      containerCpu?: number;
      containerMemory?: number;
      containerPort?: number;
    } = {};

    // Validate CPU
    if (body.cpu !== undefined) {
      const cpu = Number(body.cpu);
      if (isNaN(cpu) || cpu < 256 || cpu > 2048) {
        return NextResponse.json(
          {
            success: false,
            error: "CPU must be between 256 and 2048 units",
          },
          { status: 400 },
        );
      }
      updates.containerCpu = cpu;
    }

    // Validate Memory
    if (body.memory !== undefined) {
      const memory = Number(body.memory);
      if (isNaN(memory) || memory < 512 || memory > 2048) {
        return NextResponse.json(
          {
            success: false,
            error: "Memory must be between 512 and 2048 MB",
          },
          { status: 400 },
        );
      }
      updates.containerMemory = memory;
    }

    // Validate Port
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (isNaN(port) || port < 1 || port > 65535) {
        return NextResponse.json(
          {
            success: false,
            error: "Port must be between 1 and 65535",
          },
          { status: 400 },
        );
      }
      updates.containerPort = port;
    }

    // Validate ECR Image URI
    if (body.ecr_image_uri !== undefined) {
      const imageUri = String(body.ecr_image_uri);
      if (!imageUri || !imageUri.includes(".dkr.ecr.")) {
        return NextResponse.json(
          {
            success: false,
            error: "Invalid ECR image URI format",
          },
          { status: 400 },
        );
      }
      updates.containerImage = imageUri;
    }

    // Check if any updates were provided
    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        {
          success: false,
          error:
            "No valid updates provided. Updatable fields: cpu, memory, port, ecr_image_uri",
        },
        { status: 400 },
      );
    }

    // Update status to deploying
    await updateContainerStatus(containerId, "deploying", {
      deploymentLog: "Initiating container update via CloudFormation...",
    });

    // Update CloudFormation stack
    try {
      // Build the update config
      const updateConfig = {
        userId: container.organization_id,
        projectName: container.project_name,
        userEmail: container.name,
        containerImage:
          updates.containerImage ||
          (container.metadata?.ecr_image_uri as string),
        containerPort: updates.containerPort || container.port,
        containerCpu: updates.containerCpu || container.cpu,
        containerMemory: updates.containerMemory || container.memory,
        environmentVars: container.environment_vars || {},
      };

      await cloudFormationService.updateUserStack(updateConfig);

      // Wait for update to complete (with timeout)
      await cloudFormationService.waitForStackUpdate(
        container.organization_id,
        container.project_name,
        15,
      );

      // Update database with new values
      const dbUpdates: Partial<{
        cpu: number;
        memory: number;
        port: number;
        ecr_image_uri: string;
      }> = {};
      if (updates.containerCpu) dbUpdates.cpu = updates.containerCpu;
      if (updates.containerMemory) dbUpdates.memory = updates.containerMemory;
      if (updates.containerPort) dbUpdates.port = updates.containerPort;
      if (updates.containerImage)
        dbUpdates.ecr_image_uri = updates.containerImage;

      // Update container in database
      const updatedContainer = await containersService.update(
        containerId,
        user.organization_id!,
        dbUpdates,
      );

      if (!updatedContainer) {
        throw new Error("Failed to update container in database");
      }

      // Mark as running
      await updateContainerStatus(containerId, "running", {
        deploymentLog: "Container updated successfully",
      });

      return NextResponse.json({
        success: true,
        message: "Container updated successfully",
        data: updatedContainer,
      });
    } catch (cfError) {
      logger.error(`Failed to update CloudFormation stack:`, cfError);

      // Mark as failed
      await updateContainerStatus(containerId, "failed", {
        errorMessage:
          cfError instanceof Error ? cfError.message : "Update failed",
        deploymentLog: `CloudFormation update failed: ${cfError instanceof Error ? cfError.message : "Unknown error"}`,
      });

      return NextResponse.json(
        {
          success: false,
          error:
            cfError instanceof Error
              ? cfError.message
              : "CloudFormation update failed",
        },
        { status: 500 },
      );
    }
  } catch (error) {
    logger.error("Error updating container:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to update container",
      },
      { status: 500 },
    );
  }
}

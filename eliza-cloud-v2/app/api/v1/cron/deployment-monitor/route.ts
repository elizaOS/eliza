import { NextRequest, NextResponse } from "next/server";
import { dbRead } from "@/db/client";
import { containers } from "@/db/schemas/containers";
import { inArray } from "drizzle-orm";
import { cloudFormationService } from "@/lib/services/cloudformation";
import { updateContainerStatus } from "@/lib/services/containers";
import { creditsService } from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";
import { trackServerEvent } from "@/lib/analytics/posthog-server";
import { calculateDeploymentCost } from "@/lib/constants/pricing";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // 1 minute max

/**
 * Deployment Monitor Cron Handler
 *
 * Monitors containers in "building" or "deploying" status and updates
 * their status based on CloudFormation stack progress.
 *
 * This replaces the long-running wait in deployContainerAsync, making
 * the deployment flow compatible with Vercel serverless function limits.
 *
 * Schedule: Every minute
 */
async function handleDeploymentMonitor(request: NextRequest) {
  try {
    // Authenticate cron request
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
      logger.error(
        "[Deployment Monitor] CRON_SECRET not configured - rejecting request for security",
      );
      return NextResponse.json(
        {
          success: false,
          error: "Server configuration error: CRON_SECRET not set",
        },
        { status: 500 },
      );
    }

    if (authHeader !== `Bearer ${cronSecret}`) {
      logger.warn("[Deployment Monitor] Unauthorized request", {
        ip: request.headers.get("x-forwarded-for"),
        timestamp: new Date().toISOString(),
      });
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    logger.info("[Deployment Monitor] Starting deployment status check");

    // Get all containers that are being deployed
    const deployingContainers = await dbRead
      .select()
      .from(containers)
      .where(inArray(containers.status, ["building", "deploying"]));

    if (deployingContainers.length === 0) {
      logger.info("[Deployment Monitor] No containers in deployment state");
      return NextResponse.json({
        success: true,
        data: { monitored: 0, updated: 0, timestamp: new Date().toISOString() },
      });
    }

    logger.info(
      `[Deployment Monitor] Checking ${deployingContainers.length} containers`,
    );

    // Deployment timeout: 30 minutes is more than enough for CloudFormation (typically 8-12 min)
    const DEPLOYMENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

    const results: Array<{
      containerId: string;
      stackName: string | null;
      previousStatus: string;
      newStatus: string | null;
      error?: string;
    }> = [];

    for (const container of deployingContainers) {
      try {
        // Check for stuck/timed out deployments first
        const deploymentAge = container.created_at
          ? Date.now() - new Date(container.created_at).getTime()
          : 0;

        if (deploymentAge > DEPLOYMENT_TIMEOUT_MS) {
          // Container has been deploying for too long - mark as failed
          const timeoutMinutes = Math.round(deploymentAge / (60 * 1000));
          const failureReason = `Deployment timed out after ${timeoutMinutes} minutes. Stack may have stalled or encountered an undetectable error.`;

          logger.error(
            `[Deployment Monitor] ❌ Container ${container.id} timed out (${timeoutMinutes} minutes) - marking as failed`,
          );

          await updateContainerStatus(container.id, "failed", {
            errorMessage: failureReason,
            deploymentLog: `Deployment timeout: ${failureReason}`,
          });

          // Mark usage record as failed
          try {
            await usageService.markDeploymentFailed(
              container.id,
              container.organization_id,
              failureReason,
            );
            logger.info(
              `[Deployment Monitor] ✅ Marked usage record as failed for timed out container ${container.id}`,
            );
          } catch (usageError) {
            logger.error(
              `[Deployment Monitor] ❌ Failed to update usage record for container ${container.id}:`,
              usageError,
            );
          }

          // Refund credits
          try {
            const deploymentCost = calculateDeploymentCost({
              desiredCount: container.desired_count,
              cpu: container.cpu,
              memory: container.memory,
            });
            await creditsService.addCredits({
              organizationId: container.organization_id,
              amount: deploymentCost,
              description: `Refund for timed out deployment: ${container.name}`,
              metadata: {
                type: "refund",
                reason: "deployment_timeout",
                containerId: container.id,
                deploymentAgeMinutes: timeoutMinutes,
              },
            });
            logger.info(
              `[Deployment Monitor] ✅ Refunded ${deploymentCost} credits for timed out container ${container.id}`,
            );
          } catch (refundError) {
            logger.error(
              `[Deployment Monitor] ❌ Failed to refund credits for container ${container.id}:`,
              refundError,
            );
          }

          // Try to cleanup the stack if it exists
          if (container.cloudformation_stack_name) {
            try {
              await cloudFormationService.deleteUserStack(
                container.organization_id,
                container.project_name,
              );
              logger.info(
                `[Deployment Monitor] Initiated cleanup of timed out stack ${container.cloudformation_stack_name}`,
              );
            } catch (cleanupError) {
              logger.warn(
                `[Deployment Monitor] Failed to cleanup stack ${container.cloudformation_stack_name}:`,
                cleanupError,
              );
            }
          }

          results.push({
            containerId: container.id,
            stackName: container.cloudformation_stack_name,
            previousStatus: container.status,
            newStatus: "failed",
            error: failureReason,
          });
          continue;
        }

        const stackName = container.cloudformation_stack_name;

        if (!stackName) {
          // Stack not yet created - check if it's been too long without a stack name
          // (might be stuck in initial processing)
          if (deploymentAge > 5 * 60 * 1000) {
            // 5 minutes without stack name is suspicious
            logger.warn(
              `[Deployment Monitor] Container ${container.id} has been ${container.status} for ${Math.round(deploymentAge / 60000)} minutes without stack name`,
            );
          }
          logger.debug(
            `[Deployment Monitor] Container ${container.id} has no stack name yet, skipping`,
          );
          results.push({
            containerId: container.id,
            stackName: null,
            previousStatus: container.status,
            newStatus: null,
            error: "No stack name stored",
          });
          continue;
        }

        // Get stack status directly by name
        const stackStatus = await getStackStatusByName(stackName);

        if (!stackStatus) {
          // CRITICAL: Stack doesn't exist - this is a failure case!
          // The stack was either deleted, never created, or rolled back completely
          logger.error(
            `[Deployment Monitor] ❌ Stack ${stackName} not found for container ${container.id} - marking as failed`,
          );

          const failureReason = `CloudFormation stack does not exist: ${stackName}. Stack may have been deleted or failed to create.`;

          // Update container status to failed
          await updateContainerStatus(container.id, "failed", {
            errorMessage: failureReason,
            deploymentLog: `CloudFormation stack not found: ${stackName}`,
          });

          // Mark usage record as failed
          try {
            await usageService.markDeploymentFailed(
              container.id,
              container.organization_id,
              failureReason,
            );
            logger.info(
              `[Deployment Monitor] ✅ Marked usage record as failed for container ${container.id}`,
            );
          } catch (usageError) {
            logger.error(
              `[Deployment Monitor] ❌ Failed to update usage record for container ${container.id}:`,
              usageError,
            );
          }

          // Refund credits for the failed deployment
          try {
            const deploymentCost = calculateDeploymentCost({
              desiredCount: container.desired_count,
              cpu: container.cpu,
              memory: container.memory,
            });

            await creditsService.addCredits({
              organizationId: container.organization_id,
              amount: deploymentCost,
              description: `Refund for failed deployment (stack not found): ${container.name}`,
              metadata: {
                type: "refund",
                reason: failureReason,
                containerId: container.id,
                stackName,
              },
            });

            logger.info(
              `[Deployment Monitor] ✅ Refunded ${deploymentCost} credits for container ${container.id} (stack not found)`,
            );
          } catch (refundError) {
            logger.error(
              `[Deployment Monitor] ❌ Failed to refund credits for container ${container.id}:`,
              refundError,
            );
          }

          results.push({
            containerId: container.id,
            stackName,
            previousStatus: container.status,
            newStatus: "failed",
            error: failureReason,
          });
          continue;
        }

        logger.info(
          `[Deployment Monitor] Container ${container.id}: Stack ${stackName} is ${stackStatus.status}`,
        );

        if (
          stackStatus.status === "CREATE_COMPLETE" ||
          stackStatus.status === "UPDATE_COMPLETE"
        ) {
          // Stack completed successfully!
          const outputs = await cloudFormationService.getStackOutputs(
            container.organization_id,
            container.project_name,
          );

          if (outputs) {
            await updateContainerStatus(container.id, "running", {
              ecsServiceArn: outputs.serviceArn,
              ecsTaskDefinitionArn: outputs.taskDefinitionArn,
              ecsClusterArn: outputs.clusterArn,
              loadBalancerUrl: outputs.containerUrl,
              deploymentLog: `Deployed successfully! EC2: ${outputs.instancePublicIp}, URL: ${outputs.containerUrl}`,
            });

            // Mark usage record as successful
            try {
              const deploymentDuration = container.created_at
                ? Date.now() - new Date(container.created_at).getTime()
                : undefined;

              await usageService.markDeploymentSuccessful(
                container.id,
                container.organization_id,
                deploymentDuration,
              );
              logger.info(
                `[Deployment Monitor] ✅ Marked usage record as successful for container ${container.id}`,
              );
            } catch (usageError) {
              logger.error(
                `[Deployment Monitor] ❌ Failed to update usage record for container ${container.id}:`,
                usageError,
              );
            }

            logger.info(
              `[Deployment Monitor] ✅ Container ${container.id} deployed successfully: ${outputs.containerUrl}`,
            );

            // Track successful deployment in PostHog using internal UUID
            if (container.user_id) {
              const deploymentDuration = container.created_at
                ? Date.now() - new Date(container.created_at).getTime()
                : undefined;
              trackServerEvent(
                container.user_id,
                "container_deploy_completed",
                {
                  container_id: container.id,
                  container_name: container.name,
                  deployment_time_ms: deploymentDuration,
                  container_url: outputs.containerUrl,
                },
              );
            }

            results.push({
              containerId: container.id,
              stackName,
              previousStatus: container.status,
              newStatus: "running",
            });
          } else {
            // Stack complete but no outputs - unusual but still mark as success
            await updateContainerStatus(container.id, "running", {
              deploymentLog:
                "Stack completed but outputs not available. Container may still be starting.",
            });

            // Still mark usage record as successful since stack completed
            try {
              await usageService.markDeploymentSuccessful(
                container.id,
                container.organization_id,
              );
            } catch (usageError) {
              logger.error(
                `[Deployment Monitor] ❌ Failed to update usage record for container ${container.id}:`,
                usageError,
              );
            }

            results.push({
              containerId: container.id,
              stackName,
              previousStatus: container.status,
              newStatus: "running",
              error: "No outputs available",
            });
          }
        } else if (
          stackStatus.status === "CREATE_FAILED" ||
          stackStatus.status === "ROLLBACK_COMPLETE" ||
          stackStatus.status === "ROLLBACK_FAILED" ||
          stackStatus.status === "DELETE_COMPLETE" ||
          stackStatus.status === "UPDATE_ROLLBACK_COMPLETE"
        ) {
          // Stack failed
          const failureReason =
            stackStatus.statusReason || "Stack creation failed";

          await updateContainerStatus(container.id, "failed", {
            errorMessage: failureReason,
            deploymentLog: `CloudFormation stack failed: ${failureReason}`,
          });

          // Mark usage record as failed
          try {
            await usageService.markDeploymentFailed(
              container.id,
              container.organization_id,
              failureReason,
            );
            logger.info(
              `[Deployment Monitor] ✅ Marked usage record as failed for container ${container.id}`,
            );
          } catch (usageError) {
            logger.error(
              `[Deployment Monitor] ❌ Failed to update usage record for container ${container.id}:`,
              usageError,
            );
          }

          // Refund credits
          try {
            // Calculate deployment cost (should match what was charged)
            const deploymentCost = calculateDeploymentCost({
              desiredCount: container.desired_count,
              cpu: container.cpu,
              memory: container.memory,
            });

            await creditsService.addCredits({
              organizationId: container.organization_id,
              amount: deploymentCost,
              description: `Refund for failed deployment: ${container.name}`,
              metadata: {
                type: "refund",
                reason: failureReason,
                containerId: container.id,
                stackName,
              },
            });

            logger.info(
              `[Deployment Monitor] ✅ Refunded ${deploymentCost} credits for failed container ${container.id}`,
            );
          } catch (refundError) {
            logger.error(
              `[Deployment Monitor] ❌ Failed to refund credits for container ${container.id}:`,
              refundError,
            );
          }

          // Cleanup the failed stack
          try {
            await cloudFormationService.deleteUserStack(
              container.organization_id,
              container.project_name,
            );
            logger.info(
              `[Deployment Monitor] Initiated cleanup of failed stack ${stackName}`,
            );
          } catch (cleanupError) {
            logger.warn(
              `[Deployment Monitor] Failed to cleanup stack ${stackName}:`,
              cleanupError,
            );
          }

          results.push({
            containerId: container.id,
            stackName,
            previousStatus: container.status,
            newStatus: "failed",
            error: failureReason,
          });
        } else {
          // Stack still in progress (CREATE_IN_PROGRESS, etc.)
          logger.debug(
            `[Deployment Monitor] Container ${container.id}: Stack still in progress (${stackStatus.status})`,
          );
          results.push({
            containerId: container.id,
            stackName,
            previousStatus: container.status,
            newStatus: null, // No change
          });
        }
      } catch (containerError) {
        logger.error(
          `[Deployment Monitor] Error checking container ${container.id}:`,
          containerError,
        );
        results.push({
          containerId: container.id,
          stackName: container.cloudformation_stack_name,
          previousStatus: container.status,
          newStatus: null,
          error:
            containerError instanceof Error
              ? containerError.message
              : "Unknown error",
        });
      }
    }

    const updatedCount = results.filter((r) => r.newStatus !== null).length;

    logger.info(
      `[Deployment Monitor] Completed: ${results.length} checked, ${updatedCount} updated`,
    );

    return NextResponse.json({
      success: true,
      data: {
        monitored: results.length,
        updated: updatedCount,
        timestamp: new Date().toISOString(),
        results,
      },
    });
  } catch (error) {
    logger.error(
      "[Deployment Monitor] Failed:",
      error instanceof Error ? error.message : String(error),
    );

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Deployment monitor failed",
      },
      { status: 500 },
    );
  }
}

/**
 * Get CloudFormation stack status by stack name directly
 */
async function getStackStatusByName(
  stackName: string,
): Promise<{ status: string; statusReason?: string } | null> {
  try {
    const { DescribeStacksCommand, CloudFormationClient } =
      await import("@aws-sdk/client-cloudformation");

    const client = new CloudFormationClient({
      region: process.env.AWS_REGION || "us-east-1",
    });

    const command = new DescribeStacksCommand({
      StackName: stackName,
    });

    const response = await client.send(command);
    const stack = response.Stacks?.[0];

    if (!stack) {
      return null;
    }

    return {
      status: stack.StackStatus || "UNKNOWN",
      statusReason: stack.StackStatusReason,
    };
  } catch (error) {
    // Stack doesn't exist
    if (error instanceof Error && error.message.includes("does not exist")) {
      return null;
    }
    throw error;
  }
}

/**
 * GET /api/v1/cron/deployment-monitor
 * Cron job endpoint for monitoring container deployment status.
 * Checks CloudFormation stacks and updates container status accordingly.
 * Protected by CRON_SECRET. Can be called via GET (Vercel cron) or POST (manual testing).
 *
 * @param request - Request with Bearer token authorization header.
 * @returns Deployment monitoring results with updated container statuses.
 */
export async function GET(request: NextRequest) {
  return handleDeploymentMonitor(request);
}

/**
 * POST /api/v1/cron/deployment-monitor
 * Cron job endpoint for monitoring container deployment status (POST variant).
 * Protected by CRON_SECRET.
 *
 * @param request - Request with Bearer token authorization header.
 * @returns Deployment monitoring results with updated container statuses.
 */
export async function POST(request: NextRequest) {
  return handleDeploymentMonitor(request);
}

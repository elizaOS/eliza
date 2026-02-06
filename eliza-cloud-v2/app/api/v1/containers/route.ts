import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  creditsService,
  InsufficientCreditsError,
  type CreditReservation,
} from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { discordService } from "@/lib/services/discord";
import {
  containersService,
  listContainers,
  getContainer,
  updateContainerStatus,
  type NewContainer,
} from "@/lib/services/containers";
import { QuotaExceededError } from "@/lib/services/container-quota";
import { creditEventEmitter } from "@/lib/events/credit-events";
import {
  calculateDeploymentCost,
  CONTAINER_LIMITS,
} from "@/lib/constants/pricing";
import { isFeatureConfigured } from "@/lib/config/env-validator";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { z } from "zod";
import { trackServerEvent } from "@/lib/analytics/posthog-server";
import { sanitizeErrorMessage } from "@/lib/analytics/posthog";

export const dynamic = "force-dynamic";
// Set max duration to handle CloudFormation deployments
// CloudFormation typically takes 5-12 minutes for EC2+ECS provisioning
// Vercel limits: Hobby=300s, Pro/Enterprise=800s (configurable)
export const maxDuration = 780; // 13 minutes - allows full CloudFormation deployment

const createContainerSchema = z.object({
  name: z.string().min(1).max(100),
  project_name: z.string().min(1).max(50), // Project identifier for multi-project support
  description: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(3000),
  desired_count: z.number().int().min(1).max(10).default(1),
  cpu: z.number().int().min(256).max(2048).default(1792), // CPU units (1792 = 1.75 vCPU, 87.5% of t4g.small's 2 vCPUs)
  memory: z.number().int().min(256).max(2048).default(1792), // Memory in MB (1792 MB = 1.75 GiB, 87.5% of t4g.small's 2 GiB)
  environment_vars: z.record(z.string(), z.string()).optional(),
  health_check_path: z.string().default("/health"),

  // ECR image fields
  ecr_image_uri: z.string(), // Required: Full ECR image URI with tag
  ecr_repository_uri: z.string().optional(),
  image_tag: z.string().optional(),

  // Architecture field for multi-platform support
  architecture: z.enum(["arm64", "x86_64"]).optional().default("arm64"),
});

/**
 * GET /api/v1/containers
 * Lists all containers for the authenticated user's organization.
 *
 * @param request - The Next.js request object.
 * @returns Array of container objects.
 */
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    const containers = await listContainers(user.organization_id!);

    return NextResponse.json({
      success: true,
      data: containers,
    });
  } catch (error) {
    logger.error("Error fetching containers:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch containers",
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/v1/containers
 * Creates and deploys a new container to AWS ECS.
 * Rate limited: 5 deployments per 5 minutes.
 *
 * @param request - Request body with container configuration including ECR image URI, CPU, memory, and environment variables.
 * @returns Created container details and deployment status.
 */
async function handleCreateContainer(request: NextRequest) {
  try {
    // Check if container feature is configured
    if (!isFeatureConfigured("containers")) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Container deployments are not configured. Please set AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and ECS configuration.",
        },
        { status: 503 },
      );
    }

    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);
    const body = await request.json();

    // Validate request body
    const validatedData = createContainerSchema.parse(body);

    // Validate environment variables count and size
    if (validatedData.environment_vars) {
      const envVarCount = Object.keys(validatedData.environment_vars).length;
      if (envVarCount > CONTAINER_LIMITS.MAX_ENV_VARS) {
        return NextResponse.json(
          {
            success: false,
            error: `Too many environment variables. Maximum ${CONTAINER_LIMITS.MAX_ENV_VARS} allowed, got ${envVarCount}`,
            details: {
              limit: CONTAINER_LIMITS.MAX_ENV_VARS,
              provided: envVarCount,
            },
          },
          { status: 400 },
        );
      }

      // Validate each env var name and value size
      for (const [key, value] of Object.entries(
        validatedData.environment_vars,
      )) {
        // Validate key format
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return NextResponse.json(
            {
              success: false,
              error: `Invalid environment variable name: '${key}'. Must start with letter/underscore and contain only alphanumeric and underscores.`,
            },
            { status: 400 },
          );
        }

        // Validate value size
        const valueSize = Buffer.byteLength(value, "utf8");
        if (valueSize > CONTAINER_LIMITS.MAX_ENV_VAR_SIZE) {
          return NextResponse.json(
            {
              success: false,
              error: `Environment variable '${key}' value exceeds maximum size of ${CONTAINER_LIMITS.MAX_ENV_VAR_SIZE} bytes (got ${valueSize} bytes)`,
            },
            { status: 400 },
          );
        }
      }
    }

    // Validate ECR image URI
    if (!validatedData.ecr_image_uri) {
      return NextResponse.json(
        {
          success: false,
          error: "ecr_image_uri is required",
          details: {
            hint: "Call POST /api/v1/containers/credentials to get ECR credentials and push your Docker image to ECR first",
          },
        },
        { status: 400 },
      );
    }

    // Verify ECR image exists before deployment (prevents expensive failed deployments)
    try {
      const { getECRManager } = await import("@/lib/services/ecr");
      const ecrManager = getECRManager();
      const imageExists = await ecrManager.verifyImageExists(
        validatedData.ecr_image_uri,
      );

      if (!imageExists) {
        return NextResponse.json(
          {
            success: false,
            error: `ECR image not found: ${validatedData.ecr_image_uri}`,
            details: {
              hint: "Ensure the Docker image was successfully pushed to ECR before deploying",
            },
          },
          { status: 404 },
        );
      }
    } catch (error) {
      logger.error("Failed to verify ECR image:", error);
      // Log but don't block deployment - image might exist but verification failed
      logger.warn(
        "Proceeding with deployment despite image verification failure",
      );
    }

    // Check if a container with this project_name already exists for this user
    const existingContainers = await listContainers(user.organization_id!);
    const existingProject = existingContainers.find(
      (c) =>
        c.user_id === user.id && c.project_name === validatedData.project_name,
    );

    const isUpdate = !!existingProject;

    let container;
    let newBalance: number;
    let deploymentCost: number;

    if (isUpdate && existingProject) {
      // UPDATE: Update the existing container record

      const updateData = {
        name: validatedData.name,
        description: validatedData.description,
        ecr_repository_uri: validatedData.ecr_repository_uri,
        ecr_image_tag: validatedData.image_tag,
        image_tag: validatedData.image_tag,
        port: validatedData.port,
        desired_count: validatedData.desired_count,
        cpu: validatedData.cpu,
        memory: validatedData.memory,
        architecture: validatedData.architecture,
        environment_vars: validatedData.environment_vars || {},
        health_check_path: validatedData.health_check_path,
        status: "pending",
        is_update: "true",
        metadata: {
          ecr_image_uri: validatedData.ecr_image_uri,
          is_update: true,
          previous_image: existingProject.metadata?.ecr_image_uri,
          architecture: validatedData.architecture,
        },
      };

      const updatedContainer = await containersService.update(
        existingProject.id,
        user.organization_id!,
        updateData,
      );

      if (!updatedContainer) {
        throw new Error("Failed to update existing container");
      }

      container = updatedContainer;

      // For updates, still need to calculate cost and reserve credits
      deploymentCost = calculateDeploymentCost({
        desiredCount: validatedData.desired_count,
        cpu: validatedData.cpu,
        memory: validatedData.memory,
      });

      // Reserve credits BEFORE update deployment
      let updateReservation: CreditReservation;
      try {
        updateReservation = await creditsService.reserve({
          organizationId: user.organization_id!!,
          amount: deploymentCost,
          userId: user.id,
          description: `Container update deployment: ${validatedData.name}`,
        });
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return NextResponse.json(
            {
              success: false,
              error: "Insufficient balance for update deployment",
              requiredCredits: deploymentCost,
            },
            { status: 402 }, // Payment Required
          );
        }
        throw error;
      }

      // Confirm the reservation immediately for updates (reconciled later if stack fails)
      await updateReservation.reconcile(deploymentCost);
      newBalance = updateReservation.reservedAmount;

      creditEventEmitter.emitCreditUpdate({
        organizationId: user.organization_id!!,
        newBalance: newBalance,
        delta: -deploymentCost,
        reason: `Container update: ${validatedData.name}`,
        userId: user.id,
        timestamp: new Date(),
      });
    } else {
      // FRESH: Create a new container record

      const containerData: NewContainer = {
        name: validatedData.name,
        project_name: validatedData.project_name,
        description: validatedData.description,
        organization_id: user.organization_id!!,
        user_id: user.id,
        api_key_id: apiKey?.id || null,
        ecr_repository_uri: validatedData.ecr_repository_uri,
        ecr_image_tag: validatedData.image_tag,
        image_tag: validatedData.image_tag,
        port: validatedData.port,
        desired_count: validatedData.desired_count,
        cpu: validatedData.cpu,
        memory: validatedData.memory,
        architecture: validatedData.architecture,
        environment_vars: validatedData.environment_vars || {},
        health_check_path: validatedData.health_check_path,
        status: "pending",
        is_update: "false",
        metadata: {
          ecr_image_uri: validatedData.ecr_image_uri,
          is_update: false,
          architecture: validatedData.architecture,
        },
      };

      deploymentCost = calculateDeploymentCost({
        desiredCount: validatedData.desired_count,
        cpu: validatedData.cpu,
        memory: validatedData.memory,
      });

      let createReservation: CreditReservation;
      try {
        createReservation = await creditsService.reserve({
          organizationId: user.organization_id!!,
          amount: deploymentCost,
          userId: user.id,
          description: `Container deployment: ${validatedData.name}`,
        });
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return NextResponse.json(
            {
              success: false,
              error: `Insufficient balance. Required: $${deploymentCost.toFixed(2)}`,
              requiredCredits: deploymentCost,
            },
            { status: 402 },
          );
        }
        throw error;
      }

      try {
        container = await containersService.createWithQuotaCheck(containerData);
      } catch (error) {
        await createReservation.reconcile(0);
        throw error;
      }

      await createReservation.reconcile(deploymentCost);
      newBalance = createReservation.reservedAmount;

      creditEventEmitter.emitCreditUpdate({
        organizationId: user.organization_id!!,
        newBalance: newBalance,
        delta: -deploymentCost,
        reason: `Container deployment: ${validatedData.name}`,
        userId: user.id,
        timestamp: new Date(),
      });

      // Create usage record for audit trail
      // NOTE: is_successful is FALSE initially - deployment monitor will mark it
      // as successful when CloudFormation stack completes, or mark it as failed
      // with error_message if the deployment fails
      await usageService.create({
        organization_id: user.organization_id!!,
        user_id: user.id,
        api_key_id: apiKey?.id,
        type: "container_deployment",
        provider: "aws_ecs",
        input_cost: String(deploymentCost),
        output_cost: String(0),
        is_successful: false, // Will be updated by deployment-monitor cron when stack completes
        metadata: {
          container_id: container.id,
          container_name: validatedData.name,
          project_name: validatedData.project_name,
          desired_count: validatedData.desired_count,
          cpu: validatedData.cpu,
          memory: validatedData.memory,
          port: validatedData.port,
          is_update: false,
        },
      });
    }

    // Create usage record for updates
    if (isUpdate) {
      const updateDeploymentCost = calculateDeploymentCost({
        desiredCount: validatedData.desired_count,
        cpu: validatedData.cpu,
        memory: validatedData.memory,
      });

      // NOTE: is_successful is FALSE initially - deployment monitor will mark it
      // as successful when CloudFormation stack completes, or mark it as failed
      // with error_message if the deployment fails
      await usageService.create({
        organization_id: user.organization_id!!,
        user_id: user.id,
        api_key_id: apiKey?.id,
        type: "container_update",
        provider: "aws_ecs",
        input_cost: String(updateDeploymentCost),
        output_cost: String(0),
        is_successful: false, // Will be updated by deployment-monitor cron when stack completes
        metadata: {
          container_id: container.id,
          container_name: validatedData.name,
          project_name: validatedData.project_name,
          desired_count: validatedData.desired_count,
          cpu: validatedData.cpu,
          memory: validatedData.memory,
          port: validatedData.port,
          is_update: true,
        },
      });
    }

    // Create CloudFormation stack SYNCHRONOUSLY
    // The CreateStack API call itself is fast (milliseconds) - it just initiates the stack
    // Only the wait for completion takes 8-12 minutes, which the cron job handles
    try {
      const stackName = await initiateCloudFormationStack(
        container.id,
        validatedData,
        user.organization_id!,
      );

      // Send Discord notification for container launch (non-blocking)
      discordService
        .logContainerLaunched({
          containerId: container.id,
          containerName: validatedData.name,
          projectName: validatedData.project_name,
          userId: user.id,
          organizationId: user.organization_id!,
          ecrImageUri: validatedData.ecr_image_uri,
          architecture: validatedData.architecture || "arm64",
          cpu: validatedData.cpu,
          memory: validatedData.memory,
          port: validatedData.port,
          desiredCount: validatedData.desired_count,
          cost: deploymentCost,
          isUpdate,
          stackName,
        })
        .catch((err) => {
          logger.warn(
            "[CONTAINER DEPLOYMENT] Failed to send Discord notification",
            {
              containerId: container.id,
              error: err instanceof Error ? err.message : "Unknown error",
            },
          );
        });

      // Track container deployment started in PostHog using internal UUID
      trackServerEvent(user.id, "container_deploy_started", {
        container_id: container.id,
        container_name: validatedData.name,
        is_update: isUpdate,
        cpu: validatedData.cpu,
        memory: validatedData.memory,
        cost: deploymentCost,
      });

      // Return immediately with container info and polling instructions
      return NextResponse.json(
        {
          success: true,
          data: container,
          message:
            "Container deployment started. Poll GET /api/v1/containers/:id to check status. CloudFormation deployment typically takes 8-12 minutes.",
          creditsDeducted: deploymentCost,
          creditsRemaining: newBalance,
          stackName,
          polling: {
            endpoint: `/api/v1/containers/${container.id}`,
            intervalMs: 10000, // Suggest polling every 10 seconds
            expectedDurationMs: 600000, // 10 minutes
          },
        },
        { status: 202 }, // 202 Accepted - request accepted, processing asynchronously
      );
    } catch (stackError) {
      const errorMessage =
        stackError instanceof Error
          ? stackError.message
          : "CloudFormation stack creation failed";

      logger.error(
        `❌ [handleCreateContainer] CloudFormation stack creation failed:`,
        stackError,
      );

      // Update container status to failed
      await updateContainerStatus(container.id, "failed", {
        errorMessage,
      });

      // Mark usage record as failed with error message
      try {
        await usageService.markDeploymentFailed(
          container.id,
          user.organization_id!,
          errorMessage,
        );
      } catch (usageError) {
        logger.error(`❌ Failed to update usage record:`, usageError);
      }

      // Refund credits
      try {
        await creditsService.addCredits({
          organizationId: user.organization_id!,
          amount: deploymentCost,
          description: `Refund for failed container deployment: ${validatedData.name}`,
          metadata: {
            type: "refund",
            containerId: container.id,
            reason: errorMessage,
          },
        });
      } catch (refundError) {
        logger.error(`❌ Failed to refund credits:`, refundError);
      }

      // Track failed container deployment in PostHog using internal UUID
      trackServerEvent(user.id, "container_deploy_failed", {
        container_id: container.id,
        container_name: validatedData.name,
        error_message: sanitizeErrorMessage(errorMessage),
      });

      return NextResponse.json(
        {
          success: false,
          error: errorMessage,
          containerId: container.id,
        },
        { status: 500 },
      );
    }
  } catch (error) {
    logger.error("Error creating container:", error);

    // Handle validation errors
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request data",
          details: error.issues,
        },
        { status: 400 },
      );
    }

    // Handle quota exceeded errors
    if (error instanceof QuotaExceededError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          quota: {
            current: error.current,
            max: error.max,
          },
        },
        { status: 403 },
      );
    }

    // Handle duplicate container name errors (from unique constraint)
    if (
      error instanceof Error &&
      (error.message.includes("unique constraint") ||
        error.message.includes("duplicate key"))
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "A container with this name already exists in your organization",
        },
        { status: 409 },
      );
    }

    // Handle generic errors
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create container",
      },
      { status: 500 },
    );
  }
}

// Export rate-limited handler for POST
export const POST = withRateLimit(
  handleCreateContainer,
  RateLimitPresets.CRITICAL,
);

/**
 * Initiates CloudFormation stack creation SYNCHRONOUSLY
 * This is fast (just the API call) - the actual stack creation takes 8-12 minutes
 * and is monitored by the deployment-monitor cron job
 */
async function initiateCloudFormationStack(
  containerId: string,
  config: z.infer<typeof createContainerSchema>,
  organizationId: string,
): Promise<string> {
  const { cloudFormationService } =
    await import("@/lib/services/cloudformation");

  // Update status to building
  await updateContainerStatus(containerId, "building", {
    deploymentLog: "Provisioning dedicated EC2 instance and ECS cluster...",
  });

  // Check if shared infrastructure is deployed
  const sharedInfraExists =
    await cloudFormationService.isSharedInfrastructureDeployed();

  if (!sharedInfraExists) {
    throw new Error(
      "Shared infrastructure not deployed. Contact support or deploy infrastructure first.",
    );
  }

  // Determine architecture and instance type
  const architecture = config.architecture || "arm64";
  const instanceType = architecture === "arm64" ? "t4g.small" : "t3.small";

  // Update status to deploying
  await updateContainerStatus(containerId, "deploying", {
    deploymentLog: `Creating CloudFormation stack (1x ${instanceType} ${architecture === "arm64" ? "ARM" : "x86_64"} instance)...`,
  });

  // Prepare environment variables
  const environmentVars: Record<string, string> = {
    ...(process.env.OPENAI_API_KEY && {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    }),
    ...(config.environment_vars || {}),
  };

  // Get container to check if this is an update
  const container = await getContainer(containerId, organizationId);
  const isUpdateInDb = container?.is_update === "true";

  const stackConfig = {
    userId: organizationId,
    projectName: config.project_name,
    userEmail: config.name,
    containerImage: config.ecr_image_uri,
    containerPort: config.port,
    containerCpu: config.cpu,
    containerMemory: config.memory,
    architecture: architecture,
    keyName: process.env.EC2_KEY_NAME,
    environmentVars: environmentVars,
  };

  // Check if CloudFormation stack actually exists before deciding to update
  // A container record might exist with is_update=true, but the stack could have been
  // deleted/rolled back from a previous failed deployment
  let stackActuallyExists = false;
  if (isUpdateInDb) {
    try {
      const existingStack = await cloudFormationService.getStack(
        organizationId,
        config.project_name,
      );
      stackActuallyExists = existingStack !== null;
      if (!stackActuallyExists) {
        logger.info(
          `Container ${containerId} marked as update, but CloudFormation stack does not exist. Creating new stack instead.`,
        );
      }
    } catch (error) {
      // If we can't check, assume stack doesn't exist and create new
      logger.warn(
        `Failed to check if stack exists for ${containerId}, will create new:`,
        error,
      );
      stackActuallyExists = false;
    }
  }

  // Create or update CloudFormation stack based on actual stack existence
  // This API call is FAST (milliseconds) - it just initiates the stack
  let stackId: string;
  if (isUpdateInDb && stackActuallyExists) {
    stackId = await cloudFormationService.updateUserStack(stackConfig);
  } else {
    stackId = await cloudFormationService.createUserStack(stackConfig);
  }

  // Get the stack name for storage
  const stackName = cloudFormationService.getStackName(
    organizationId,
    config.project_name,
  );

  // Update container with stack name
  await updateContainerStatus(containerId, "deploying", {
    cloudformationStackName: stackName,
    deploymentLog: `CloudFormation stack "${stackName}" creation initiated. Monitoring for completion...`,
  });

  return stackName;
}

/**
 * Deploy Action - Main deployment logic
 */

import { logger } from "@elizaos/core";
import * as path from "node:path";
import * as fs from "node:fs";
import dotenv from "dotenv";
import type { DeployOptions, DeploymentResult, ContainerConfig } from "../types";
import {
  buildDockerImage,
  checkDockerAvailable,
  generateDefaultDockerfile,
  exportDockerImage,
  cleanupImageTarball,
} from "../utils/docker";
import {
  CloudApiClient,
  getApiCredentials,
} from "../utils/api-client";
import { detectDirectoryType } from "@/src/utils/directory-detection";

/**
 * Main deployment handler
 */
export async function deployProject(
  options: DeployOptions,
): Promise<DeploymentResult> {
  try {
    // Load .env files from current directory and parent directories
    const cwd = process.cwd();
    const envPaths = [
      path.join(cwd, ".env"),
      path.join(cwd, ".env.local"),
      path.join(cwd, "..", ".env"),
      path.join(cwd, "..", ".env.local"),
      path.join(cwd, "../..", ".env"),
      path.join(cwd, "../..", ".env.local"),
    ];

    for (const envPath of envPaths) {
      if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath });
        logger.debug(`Loaded environment from: ${envPath}`);
      }
    }

    // Step 1: Validate environment
    logger.info("🚀 Starting ElizaOS deployment...");

    const dirInfo = detectDirectoryType(cwd);

    if (!dirInfo.hasPackageJson) {
      return {
        success: false,
        error: "Not in a valid project directory. No package.json found.",
      };
    }

    // Step 2: Get API credentials
    const credentials = getApiCredentials();
    if (!credentials && !options.apiKey) {
      return {
        success: false,
        error:
          "No API key found. Set ELIZAOS_API_KEY environment variable or use --api-key flag.",
      };
    }

    const apiClient = new CloudApiClient({
      apiKey: options.apiKey || credentials!.apiKey,
      apiUrl: options.apiUrl || credentials!.apiUrl,
    });

    // Step 2.5: Check quota before proceeding
    logger.info("💳 Checking account quota and credits...");
    const quotaResponse = await apiClient.getQuota();

    if (quotaResponse.success && quotaResponse.data) {
      const { quota, credits, pricing } = quotaResponse.data;

      logger.info(
        `📊 Containers: ${quota.current}/${quota.max} (${quota.remaining} remaining)`,
      );
      logger.info(`💰 Credit balance: ${credits.balance} credits`);

      // Warn if quota is low
      if (quota.remaining === 0) {
        logger.warn(
          `⚠️  Container limit reached! You have ${quota.current}/${quota.max} containers.`,
        );
        logger.warn(
          "   Delete unused containers or upgrade your plan to continue.",
        );
        return {
          success: false,
          error: `Container limit reached (${quota.max}). Delete unused containers or contact support.`,
        };
      }

      // Warn if credits are low
      const totalCost = pricing.totalForNewContainer || 1500;
      if (credits.balance < totalCost) {
        logger.warn(`⚠️  Insufficient credits for deployment.`);
        logger.warn(`   Required: ${totalCost} credits`);
        logger.warn(`   Available: ${credits.balance} credits`);
        logger.warn(`   Please add credits to your account to continue.`);
        return {
          success: false,
          error: `Insufficient credits. Required: ${totalCost}, Available: ${credits.balance}`,
        };
      }

      // Show cost preview
      logger.info(`💸 Deployment cost: ~${totalCost} credits`);
    }

    // Step 3: Determine project name
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
    );
    const projectName =
      options.name || packageJson.name || path.basename(cwd);

    logger.info(`📦 Deploying project: ${projectName}`);

    // Step 4: Check Docker
    if (!(await checkDockerAvailable())) {
      return {
        success: false,
        error:
          "Docker is not installed or not running. Please install Docker and try again.",
      };
    }

    // Step 5: Ensure Dockerfile exists
    let dockerfilePath = options.dockerfile || "Dockerfile";
    const fullDockerfilePath = path.join(cwd, dockerfilePath);

    if (!fs.existsSync(fullDockerfilePath)) {
      logger.warn("No Dockerfile found. Generating default Dockerfile...");
      dockerfilePath = generateDefaultDockerfile(cwd);
    }

    // Sanitize project name for Docker tag and worker naming
    // Remove @ prefix and scope, replace invalid chars with hyphens, remove leading/trailing hyphens
    const sanitizedName = projectName
      .toLowerCase()
      .replace(/^@/, "")           // Remove leading @
      .replace(/\//g, "-")          // Replace / with -
      .replace(/[^a-z0-9-]/g, "-")  // Replace other invalid chars with -
      .replace(/^-+|-+$/g, "")      // Remove leading/trailing hyphens
      .replace(/-+/g, "-");         // Replace multiple consecutive hyphens with single hyphen

    // Track uploaded image ID for later use
    let uploadedImageId: string | undefined;

    // Step 6: Build Docker image
    if (options.build !== false) {
      logger.info("🔨 Building Docker image...");

      const imageTag =
        options.tag ||
        `elizaos/${sanitizedName}:latest`;

      const buildResult = await buildDockerImage({
        dockerfile: dockerfilePath,
        tag: imageTag,
        context: cwd,
        platform: "linux/amd64", // Cloudflare uses amd64
      });

      if (!buildResult.success) {
        return {
          success: false,
          error: `Docker build failed: ${buildResult.error}`,
        };
      }

      logger.info(`✅ Docker image built: ${imageTag}`);

      // Step 6.5: Export and upload image to Cloudflare
      logger.info("📦 Exporting Docker image...");

      const exportResult = await exportDockerImage(imageTag);

      if (!exportResult.success || !exportResult.tarballPath) {
        return {
          success: false,
          error: `Failed to export Docker image: ${exportResult.error}`,
        };
      }

      // Use try/finally to ensure cleanup even on failure
      try {
        logger.info(`📤 Uploading image to cloud...`);

        const uploadResult = await apiClient.uploadImage(
          sanitizedName,
          exportResult.tarballPath,
        );

      if (!uploadResult.success || !uploadResult.data) {
        // Check if it's a credits error
        if (uploadResult.error?.includes("Insufficient credits")) {
          logger.error("❌ Upload failed: Insufficient credits");
          logger.error("   Please add credits to your account to continue.");
        }
        return {
          success: false,
          error: `Failed to upload image: ${uploadResult.error}`,
        };
      }

      // Log credits info if available
      if (uploadResult.creditsDeducted) {
        logger.info(
          `💰 Credits deducted for upload: ${uploadResult.creditsDeducted}`,
        );
      }

        // Store the uploaded image ID for deployment
        uploadedImageId = uploadResult.data.imageId;
        logger.info(`✅ Image uploaded: ${uploadedImageId}`);
      } finally {
        // Always cleanup tarball, even if upload failed
        await cleanupImageTarball(exportResult.tarballPath);
      }
    }

    // Step 7: Parse environment variables
    const environmentVars: Record<string, string> = {};
    if (options.env) {
      for (const envPair of options.env) {
        const [key, ...valueParts] = envPair.split("=");
        if (key && valueParts.length > 0) {
          environmentVars[key] = valueParts.join("=");
        }
      }
    }

    // Step 8: Create deployment configuration
    const containerConfig: ContainerConfig = {
      name: projectName,
      description: packageJson.description || `ElizaOS project: ${projectName}`,
      // Use uploaded image ID if available, otherwise fallback to tag
      image_tag: options.build !== false && uploadedImageId ? uploadedImageId : (options.tag || "latest"),
      dockerfile_path: dockerfilePath,
      port: options.port || 3000,
      max_instances: options.maxInstances || 1,
      environment_vars: environmentVars,
      health_check_path: "/health",
    };

    // Step 9: Create container deployment
    logger.info("☁️  Deploying to Cloudflare Containers...");

    const createResponse = await apiClient.createContainer(containerConfig);

    if (!createResponse.success || !createResponse.data) {
      // Check for specific error types
      if (createResponse.error?.includes("Container limit reached")) {
        logger.error("❌ Deployment failed: Container limit reached");
        logger.error("   Delete unused containers or upgrade your plan.");
      } else if (createResponse.error?.includes("Insufficient credits")) {
        logger.error("❌ Deployment failed: Insufficient credits");
        logger.error("   Please add credits to your account.");
      }
      return {
        success: false,
        error: createResponse.error || "Failed to create container",
      };
    }

    // Log credits info if available
    if (createResponse.creditsDeducted && createResponse.creditsRemaining) {
      logger.info(
        `💰 Credits deducted: ${createResponse.creditsDeducted} (${createResponse.creditsRemaining} remaining)`,
      );
    }

    const containerId = createResponse.data.id;
    logger.info(`✅ Container created: ${containerId}`);

    // Step 10: Wait for deployment to complete
    logger.info("⏳ Waiting for deployment to complete...");

    const deploymentResponse = await apiClient.waitForDeployment(containerId, {
      maxAttempts: 60,
      intervalMs: 5000,
    });

    if (!deploymentResponse.success || !deploymentResponse.data) {
      return {
        success: false,
        containerId,
        error: deploymentResponse.error || "Deployment failed",
      };
    }

    const container = deploymentResponse.data;

    // Step 11: Success!
    logger.info("✅ Deployment successful!");
    logger.info(`📍 Container ID: ${container.id}`);

    if (container.cloudflare_worker_id) {
      logger.info(`🌐 Worker ID: ${container.cloudflare_worker_id}`);
    }

    // Extract actual URL from deployment response if available
    const deploymentUrl = container.deployment_url || 
                          container.cloudflare_url || 
                          (container.cloudflare_worker_id ? `https://${sanitizedName}-${container.cloudflare_worker_id.slice(0, 8)}.workers.dev` : undefined);

    return {
      success: true,
      containerId: container.id,
      workerId: container.cloudflare_worker_id,
      url: deploymentUrl,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("Deployment error:", errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  }
}


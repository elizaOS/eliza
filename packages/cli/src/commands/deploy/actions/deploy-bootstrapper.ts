/**
 * Deploy Action with Bootstrapper Architecture
 * Deploys ElizaOS projects using artifact-based deployment
 */

import { logger } from "@elizaos/core";
import * as path from "node:path";
import * as fs from "node:fs";
import dotenv from "dotenv";
import type {
  DeployOptions,
  DeploymentResult,
  ContainerConfig,
  ArtifactUploadResponse,
  BootstrapperConfig,
} from "../types";
import { createArtifact, cleanupArtifacts } from "../utils/artifact";
import { CloudApiClient, getApiCredentials } from "../utils/api-client";
import { detectDirectoryType } from "@/src/utils/directory-detection";

// Bootstrapper image tag - configurable via BOOTSTRAPPER_IMAGE_TAG environment variable
const BOOTSTRAPPER_IMAGE_TAG = process.env.BOOTSTRAPPER_IMAGE_TAG || "elizaos/bootstrapper:latest";

/**
 * Deploy project using bootstrapper architecture
 */
export async function deployWithBootstrapper(
  options: DeployOptions,
): Promise<DeploymentResult> {
  try {
    // Load environment files
    const cwd = process.cwd();
    loadEnvironmentFiles(cwd);

    // Step 1: Validate environment
    logger.info("🚀 Starting ElizaOS deployment (Bootstrapper mode)...");

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

    // Step 3: Check quota
    logger.info("💳 Checking account quota and credits...");
    const quotaCheck = await checkQuotaAndCredits(apiClient);
    if (!quotaCheck.success) {
      return quotaCheck;
    }

    // Step 4: Parse project info
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
    );
    const projectName = options.name || packageJson.name || path.basename(cwd);
    const projectVersion = packageJson.version || "0.0.0";

    logger.info(`📦 Deploying project: ${projectName} v${projectVersion}`);

    // Step 5: Create or use existing artifact
    let artifactPath: string;
    let artifactChecksum: string;
    let artifactSize: number;

    if (options.skipArtifact && options.artifactPath) {
      // Use existing artifact
      logger.info("📦 Using existing artifact...");
      artifactPath = options.artifactPath;

      if (!fs.existsSync(artifactPath)) {
        return {
          success: false,
          error: `Artifact not found: ${artifactPath}`,
        };
      }

      // Calculate checksum
      const { calculateChecksum } = await import("../utils/artifact");
      artifactChecksum = await calculateChecksum(artifactPath);
      artifactSize = fs.statSync(artifactPath).size;
    } else {
      // Create new artifact
      logger.info("📦 Creating deployment artifact...");

      const artifactResult = await createArtifact({
        projectPath: cwd,
        excludePatterns: options.env ? [] : [".env", ".env.*"],
        includeEnv: false,
        deterministic: true,
      });

      if (!artifactResult.success || !artifactResult.artifactPath) {
        return {
          success: false,
          error: `Failed to create artifact: ${artifactResult.error}`,
        };
      }

      artifactPath = artifactResult.artifactPath;
      artifactChecksum = artifactResult.checksum!;
      artifactSize = artifactResult.size!;

      logger.info(
        `✅ Artifact created: ${path.basename(artifactPath)} (${(artifactSize / 1024 / 1024).toFixed(2)} MB)`,
      );
    }

    // Step 6: Upload artifact to R2 via Cloud API
    logger.info("📤 Uploading artifact to cloud storage...");

    // Validate artifact exists before upload
    if (!fs.existsSync(artifactPath)) {
      return {
        success: false,
        error: `Artifact file not found: ${artifactPath}`,
      };
    }

    const uploadResponse = await apiClient.uploadArtifact({
      projectId: sanitizeProjectName(projectName),
      version: projectVersion,
      checksum: artifactChecksum,
      size: artifactSize,
      artifactPath,
      metadata: {
        elizaVersion: packageJson.dependencies?.["@elizaos/core"] || "unknown",
        nodeVersion: process.version,
        deployedAt: new Date().toISOString(),
      },
    });

    if (!uploadResponse.success || !uploadResponse.data) {
      return {
        success: false,
        error: `Failed to upload artifact: ${uploadResponse.error}`,
      };
    }

    const artifactData = uploadResponse.data as ArtifactUploadResponse;

    // Validate artifact data (new format with upload/download URLs)
    if (!artifactData.download?.url) {
      return {
        success: false,
        error: "Invalid artifact upload response: missing download URL",
      };
    }

    // Validate download URL is accessible and well-formed
    try {
      const downloadUrl = new URL(artifactData.download.url);
      if (!downloadUrl.protocol.startsWith("http")) {
        return {
          success: false,
          error: `Invalid artifact download URL protocol: ${downloadUrl.protocol}`,
        };
      }
      logger.debug(`Validated artifact download URL: ${downloadUrl.origin}${downloadUrl.pathname.substring(0, 50)}...`);
    } catch (urlError) {
      return {
        success: false,
        error: `Invalid artifact download URL format: ${urlError instanceof Error ? urlError.message : "Unknown error"}`,
      };
    }

    // Log credits info
    if (uploadResponse.creditsDeducted) {
      logger.info(
        `💰 Credits deducted for upload: ${uploadResponse.creditsDeducted}`,
      );
    }

    logger.info(`✅ Artifact uploaded successfully`);

    // Step 7: Clean up old artifacts locally
    const artifactDir = path.dirname(artifactPath);
    await cleanupArtifacts(artifactDir, 3); // Keep last 3 artifacts

    // Step 8: Parse environment variables
    const environmentVars = parseEnvironmentVariables(options.env);

    // Step 9: Create bootstrapper deployment configuration
    const bootstrapperConfig: BootstrapperConfig = {
      artifactUrl: artifactData.download.url, // Use download URL for container
      artifactChecksum,
      r2Token: "", // No longer needed - presigned URL
      startCommand: "bun run start",
      skipBuild: false,
      envVars: environmentVars,
    };

    // Step 10: Create container with bootstrapper config
    const containerConfig: ContainerConfig = {
      name: projectName,
      description: packageJson.description || `ElizaOS project: ${projectName}`,
      image_tag: BOOTSTRAPPER_IMAGE_TAG,
      port: options.port || 3000,
      max_instances: options.maxInstances || 1,
      environment_vars: {
        ...environmentVars,
        R2_ARTIFACT_URL: bootstrapperConfig.artifactUrl,
        R2_TOKEN: bootstrapperConfig.r2Token,
        R2_ARTIFACT_CHECKSUM: bootstrapperConfig.artifactChecksum,
        START_CMD: bootstrapperConfig.startCommand || "bun run start",
        SKIP_BUILD: bootstrapperConfig.skipBuild ? "true" : "false",
        PORT: (options.port || 3000).toString(),
      },
      health_check_path: "/health",
      use_bootstrapper: true,
      artifact_url: artifactData.download.url,
      artifact_checksum: artifactChecksum,
    };

    logger.info("☁️  Deploying to Cloudflare Containers...");

    const createResponse = await apiClient.createContainer(containerConfig);

    if (!createResponse.success || !createResponse.data) {
      return {
        success: false,
        error: createResponse.error || "Failed to create container",
      };
    }

    // Log credits info
    if (createResponse.creditsDeducted && createResponse.creditsRemaining) {
      logger.info(
        `💰 Credits deducted: ${createResponse.creditsDeducted} (${createResponse.creditsRemaining} remaining)`,
      );
    }

    const containerId = createResponse.data.id;
    logger.info(`✅ Container created: ${containerId}`);

    // Step 11: Wait for deployment
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

    // Step 12: Success!
    logger.info("✅ Deployment successful!");
    logger.info(`📍 Container ID: ${container.id}`);

    if (container.cloudflare_worker_id) {
      logger.info(`🌐 Worker ID: ${container.cloudflare_worker_id}`);
    }

    const deploymentUrl =
      container.deployment_url ||
      container.cloudflare_url ||
      (container.cloudflare_worker_id
        ? `https://${sanitizeProjectName(projectName)}-${container.cloudflare_worker_id.slice(0, 8)}.workers.dev`
        : undefined);

    if (deploymentUrl) {
      logger.info(`🔗 URL: ${deploymentUrl}`);
    }

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

/**
 * Load environment files from project directory
 */
function loadEnvironmentFiles(cwd: string): void {
  const envPaths = [
    path.join(cwd, ".env"),
    path.join(cwd, ".env.local"),
    path.join(cwd, "..", ".env"),
    path.join(cwd, "..", ".env.local"),
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      logger.debug(`Loaded environment from: ${envPath}`);
    }
  }
}

/**
 * Check quota and credits before deployment
 */
async function checkQuotaAndCredits(
  apiClient: CloudApiClient,
): Promise<DeploymentResult> {
  const quotaResponse = await apiClient.getQuota();

  if (quotaResponse.success && quotaResponse.data) {
    const { quota, credits, pricing } = quotaResponse.data;

    logger.info(
      `📊 Containers: ${quota.current}/${quota.max} (${quota.remaining} remaining)`,
    );
    logger.info(`💰 Credit balance: ${credits.balance} credits`);

    if (quota.remaining === 0) {
      logger.warn(
        `⚠️  Container limit reached! You have ${quota.current}/${quota.max} containers.`,
      );
      return {
        success: false,
        error: `Container limit reached (${quota.max}). Delete unused containers or contact support.`,
      };
    }

    const totalCost = pricing.totalForNewContainer || 1500;
    if (credits.balance < totalCost) {
      logger.warn(`⚠️  Insufficient credits for deployment.`);
      logger.warn(`   Required: ${totalCost} credits`);
      logger.warn(`   Available: ${credits.balance} credits`);
      return {
        success: false,
        error: `Insufficient credits. Required: ${totalCost}, Available: ${credits.balance}`,
      };
    }

    logger.info(`💸 Estimated deployment cost: ~${totalCost} credits`);
  }

  return { success: true };
}

/**
 * Sanitize project name for use in URLs and identifiers
 */
function sanitizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@/, "") // Remove leading @
    .replace(/\//g, "-") // Replace / with -
    .replace(/[^a-z0-9-]/g, "-") // Replace invalid chars with -
    .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
    .replace(/-+/g, "-"); // Replace multiple hyphens with single
}

/**
 * Parse environment variables from CLI options
 */
function parseEnvironmentVariables(
  envOptions?: string[],
): Record<string, string> {
  const environmentVars: Record<string, string> = {};

  if (envOptions) {
    for (const envPair of envOptions) {
      const [key, ...valueParts] = envPair.split("=");
      if (key && valueParts.length > 0) {
        environmentVars[key] = valueParts.join("=");
      }
    }
  }

  return environmentVars;
}

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

    // Step 3: Parse project info
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
    );
    const projectName = options.name || packageJson.name || path.basename(cwd);
    const projectVersion = packageJson.version || "0.0.0";

    logger.info(`📦 Deploying project: ${projectName} v${projectVersion}`);

    // PERFORMANCE OPTIMIZATION: Run artifact creation and quota check in parallel
    // These are independent operations and can be done concurrently
    logger.info("🔄 Starting parallel operations: artifact preparation & quota check...");

    let artifactPath: string;
    let artifactChecksum: string;
    let artifactSize: number;

    let artifactResultOrPath;
    let quotaCheckResult;

    try {
      [artifactResultOrPath, quotaCheckResult] = await Promise.all([
        // Parallel operation 1: Prepare artifact
        (async () => {
          if (options.skipArtifact && options.artifactPath) {
            // Use existing artifact
            logger.info("📦 Using existing artifact...");
            const existingPath = options.artifactPath;

            if (!fs.existsSync(existingPath)) {
              throw new Error(`Artifact not found: ${existingPath}`);
            }

            // Calculate checksum
            const { calculateChecksum } = await import("../utils/artifact");
            const checksum = await calculateChecksum(existingPath);
            const size = fs.statSync(existingPath).size;

            return { path: existingPath, checksum, size };
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
              throw new Error(`Failed to create artifact: ${artifactResult.error}`);
            }

            return {
              path: artifactResult.artifactPath,
              checksum: artifactResult.checksum!,
              size: artifactResult.size!,
            };
          }
        })(),
        
        // Parallel operation 2: Check quota (moved from Step 3)
        (async () => {
          logger.info("💳 Checking account quota and credits...");
          return await checkQuotaAndCredits(apiClient);
        })(),
      ]);
    } catch (parallelError: unknown) {
      const errorMessage = parallelError instanceof Error ? parallelError.message : "Unknown error";
      return {
        success: false,
        error: `Preparation failed: ${errorMessage}`,
      };
    }

    // Check quota result
    if (!quotaCheckResult.success) {
      return quotaCheckResult;
    }

    // Extract artifact info
    artifactPath = artifactResultOrPath.path;
    artifactChecksum = artifactResultOrPath.checksum;
    artifactSize = artifactResultOrPath.size;

    logger.info(
      `✅ Artifact ready: ${path.basename(artifactPath)} (${(artifactSize / 1024 / 1024).toFixed(2)} MB)`,
    );

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

    // Log credits info if present
    if ("creditsDeducted" in uploadResponse && uploadResponse.creditsDeducted) {
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
        R2_ARTIFACT_CHECKSUM: bootstrapperConfig.artifactChecksum,
        START_CMD: bootstrapperConfig.startCommand || "bun run start",
        SKIP_BUILD: bootstrapperConfig.skipBuild ? "true" : "false",
        PORT: (options.port || 3000).toString(),
      },
      health_check_path: "/health",
      use_bootstrapper: true,
      artifact_url: artifactData.download.url, // Presigned URL (expires)
      artifact_id: artifactData.artifactId, // Immutable ID for tracking
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

    // Log credits info if present
    if ("creditsDeducted" in createResponse && "creditsRemaining" in createResponse) {
      logger.info(
        `💰 Credits deducted: ${createResponse.creditsDeducted} (${createResponse.creditsRemaining} remaining)`,
      );
    }

    const containerId = createResponse.data.id;
    logger.info(`✅ Container created: ${containerId}`);

    // Step 11: Wait for deployment
    logger.info("⏳ Waiting for deployment to complete...");
    logger.info("   This may take several minutes. You can check status at:");
    logger.info(`   https://elizacloud.ai/dashboard/containers/${containerId}`);

    const deploymentResponse = await apiClient.waitForDeployment(containerId, {
      maxAttempts: 120, // 10 minutes to match backend timeout
      intervalMs: 5000,
    });

    if (!deploymentResponse.success) {
      // Provide detailed error information from backend
      const errorDetails = deploymentResponse.error || "Deployment failed";
      
      logger.error("❌ Deployment failed:");
      logger.error(`   ${errorDetails}`);
      logger.error("");
      logger.error("💡 Troubleshooting tips:");
      logger.error("   1. Check container logs at: https://elizacloud.ai/dashboard/containers");
      logger.error("   2. Verify your artifact is valid (try deploying locally first)");
      logger.error("   3. Check environment variables are correct");
      logger.error("   4. Ensure health check endpoint returns 200 OK");
      
      return {
        success: false,
        containerId,
        error: errorDetails,
      };
    }

    // Type guard - at this point deploymentResponse.success is true
    if (!deploymentResponse.data) {
      return {
        success: false,
        containerId,
        error: "Deployment succeeded but no container data returned",
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
 * Enforces strict validation to prevent injection attacks
 * 
 * @param name - Project name to sanitize
 * @returns Sanitized name safe for use in URLs
 * @throws Error if name becomes empty or invalid after sanitization
 */
function sanitizeProjectName(name: string): string {
  if (!name || typeof name !== "string") {
    throw new Error("Project name is required and must be a string");
  }

  // Normalize unicode to ASCII equivalents
  let sanitized = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .toLowerCase()
    .replace(/^@/, "") // Remove leading @
    .replace(/\//g, "-") // Replace / with -
    .replace(/[^a-z0-9-]/g, "-") // Replace invalid chars with -
    .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
    .replace(/-+/g, "-"); // Replace multiple hyphens with single

  // Validate result is not empty
  if (!sanitized || sanitized.trim() === "") {
    throw new Error(
      `Project name '${name}' becomes empty after sanitization. Use only alphanumeric characters and hyphens.`
    );
  }

  // Enforce maximum length (DNS label limit is 63, use 50 for safety with suffixes)
  const MAX_NAME_LENGTH = 50;
  if (sanitized.length > MAX_NAME_LENGTH) {
    sanitized = sanitized.substring(0, MAX_NAME_LENGTH);
    // Remove trailing hyphen if truncation created one
    sanitized = sanitized.replace(/-+$/, "");
    logger.warn(
      `Project name truncated to ${MAX_NAME_LENGTH} characters: '${sanitized}'`
    );
  }

  // Ensure doesn't start with hyphen after all processing
  if (sanitized.startsWith("-")) {
    sanitized = sanitized.substring(1);
  }

  // Final validation: must have at least 1 character
  if (sanitized.length === 0) {
    throw new Error(
      `Project name '${name}' is invalid. Must contain at least one alphanumeric character.`
    );
  }

  // Validate only contains safe characters
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sanitized)) {
    throw new Error(
      `Sanitized project name '${sanitized}' failed final validation. Must start and end with alphanumeric.`
    );
  }

  return sanitized;
}

/**
 * Environment variable limits (matching Cloud API constraints)
 */
const MAX_ENV_VARS = 50;
const MAX_ENV_VAR_SIZE = 32 * 1024; // 32KB
const RESERVED_ENV_VARS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "LANG",
  "NODE_ENV",
  "PORT", // Managed by deployment config
  "R2_ARTIFACT_URL", // Managed by bootstrapper
  "R2_ACCESS_KEY_ID", // Managed by bootstrapper
  "R2_SECRET_ACCESS_KEY", // Managed by bootstrapper
  "R2_SESSION_TOKEN", // Managed by bootstrapper
  "R2_ARTIFACT_CHECKSUM", // Managed by bootstrapper
  "START_CMD", // Managed by bootstrapper
  "SKIP_BUILD", // Managed by bootstrapper
];

/**
 * Validate environment variable name
 * Must be alphanumeric + underscore, start with letter or underscore
 */
function validateEnvVarName(name: string): { valid: boolean; error?: string } {
  if (!name || name.trim() === "") {
    return { valid: false, error: "Environment variable name cannot be empty" };
  }

  // Check for reserved names
  if (RESERVED_ENV_VARS.includes(name)) {
    return {
      valid: false,
      error: `'${name}' is a reserved environment variable and cannot be overridden`,
    };
  }

  // Must start with letter or underscore
  if (!/^[A-Za-z_]/.test(name)) {
    return {
      valid: false,
      error: `'${name}' must start with a letter or underscore`,
    };
  }

  // Only alphanumeric and underscore allowed
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    return {
      valid: false,
      error: `'${name}' contains invalid characters. Only letters, numbers, and underscores allowed.`,
    };
  }

  // Reasonable length limit
  if (name.length > 200) {
    return {
      valid: false,
      error: `'${name}' exceeds maximum length of 200 characters`,
    };
  }

  return { valid: true };
}

/**
 * Parse and validate environment variables from CLI options
 * Enforces security constraints and API limits
 */
function parseEnvironmentVariables(
  envOptions?: string[],
): Record<string, string> {
  const environmentVars: Record<string, string> = {};

  if (!envOptions || envOptions.length === 0) {
    return environmentVars;
  }

  // Check count limit
  if (envOptions.length > MAX_ENV_VARS) {
    throw new Error(
      `Too many environment variables. Maximum ${MAX_ENV_VARS} allowed, got ${envOptions.length}`,
    );
  }

  for (let i = 0; i < envOptions.length; i++) {
    const envPair = envOptions[i];

    // Parse KEY=VALUE format
    const equalIndex = envPair.indexOf("=");
    if (equalIndex === -1) {
      throw new Error(
        `Invalid environment variable format at position ${i + 1}: '${envPair}'. Expected KEY=VALUE`,
      );
    }

    const key = envPair.substring(0, equalIndex);
    const value = envPair.substring(equalIndex + 1);

    // Validate key
    const keyValidation = validateEnvVarName(key);
    if (!keyValidation.valid) {
      throw new Error(
        `Invalid environment variable at position ${i + 1}: ${keyValidation.error}`,
      );
    }

    // Validate value is not empty (empty values are technically valid but likely a mistake)
    if (value === "") {
      logger.warn(
        `Warning: Environment variable '${key}' has an empty value. This may cause issues.`,
      );
    }

    // Check value size
    const valueSize = Buffer.byteLength(value, "utf8");
    if (valueSize > MAX_ENV_VAR_SIZE) {
      throw new Error(
        `Environment variable '${key}' value exceeds maximum size of ${MAX_ENV_VAR_SIZE} bytes (got ${valueSize} bytes)`,
      );
    }

    // Check for duplicate keys
    if (environmentVars[key]) {
      logger.warn(
        `Warning: Environment variable '${key}' specified multiple times. Using last value.`,
      );
    }

    environmentVars[key] = value;
  }

  // Final check: ensure we don't exceed MAX_ENV_VARS after parsing
  const totalVars = Object.keys(environmentVars).length;
  if (totalVars > MAX_ENV_VARS) {
    throw new Error(
      `Too many unique environment variables. Maximum ${MAX_ENV_VARS} allowed, got ${totalVars}`,
    );
  }

  return environmentVars;
}

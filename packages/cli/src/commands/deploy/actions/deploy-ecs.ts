/**
 * Deploy Action with Docker and AWS ECS
 * Deploys ElizaOS projects using Docker containers to AWS ECS
 */

import { logger } from '@elizaos/core';
import * as path from 'node:path';
import * as fs from 'node:fs';
import dotenv from 'dotenv';
import ora from 'ora';
import type {
  DeployOptions,
  DeploymentResult,
  ContainerConfig,
  ImageBuildResponse,
} from '../types';
import {
  checkDockerAvailable,
  buildDockerImage,
  pushDockerImage,
  cleanupLocalImages,
} from '../utils/docker-build';
import { CloudApiClient, getApiCredentials } from '../utils/api-client';
import { detectDirectoryType } from '@/src/utils/directory-detection';

/**
 * Deploy project using Docker and AWS ECS
 */
export async function deployWithECS(options: DeployOptions): Promise<DeploymentResult> {
  try {
    // Load environment files
    const cwd = process.cwd();
    loadEnvironmentFiles(cwd);

    // Step 1: Validate environment
    logger.info(
      { src: 'cli', command: 'deploy-ecs' },
      'Starting ElizaOS deployment (Docker + AWS ECS)'
    );

    const dirInfo = detectDirectoryType(cwd);
    if (!dirInfo.hasPackageJson) {
      return {
        success: false,
        error: 'Not in a valid project directory. No package.json found.',
      };
    }

    // Step 2: Check Docker availability
    logger.info({ src: 'cli', command: 'deploy-ecs' }, 'Checking Docker availability');
    const dockerAvailable = await checkDockerAvailable();
    if (!dockerAvailable) {
      return {
        success: false,
        error:
          'Docker is not installed or not running. Please install Docker and start the Docker daemon.',
      };
    }

    // Step 3: Get API credentials
    const credentials = getApiCredentials();
    if (!credentials && !options.apiKey) {
      return {
        success: false,
        error: 'No API key found. Set ELIZAOS_API_KEY environment variable or use --api-key flag.',
      };
    }

    const apiClient = new CloudApiClient({
      apiKey: options.apiKey || credentials!.apiKey,
      apiUrl: options.apiUrl || credentials!.apiUrl,
    });

    // Step 4: Parse project info
    const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
    const containerName = options.name || packageJson.name || path.basename(cwd);
    const projectName = options.projectName || path.basename(cwd); // Use directory name if not specified
    const projectVersion = packageJson.version || '0.0.0';

    logger.info(
      { src: 'cli', command: 'deploy-ecs', containerName, version: projectVersion },
      'Deploying project'
    );
    logger.info({ src: 'cli', command: 'deploy-ecs', projectName }, 'Project identifier');

    // Step 5: Check quota and credits
    logger.info({ src: 'cli', command: 'deploy-ecs' }, 'Checking account quota and credits');
    const quotaCheck = await checkQuotaAndCredits(apiClient);
    if (!quotaCheck.success) {
      return quotaCheck;
    }

    // Step 6: Build Docker image (unless skipped)
    let imageTag = options.imageUri;
    let localImageTag: string | undefined;

    if (!options.skipBuild) {
      logger.info({ src: 'cli', command: 'deploy-ecs' }, 'Building Docker image');

      localImageTag = `${sanitizeProjectName(projectName)}:${projectVersion}`;

      const buildResult = await buildDockerImage({
        projectPath: cwd,
        imageTag: localImageTag,
        buildArgs: {
          NODE_ENV: 'production',
        },
        platform: options.platform,
      });

      if (!buildResult.success) {
        return {
          success: false,
          error: `Docker build failed: ${buildResult.error}`,
        };
      }

      // Build result already logged by buildDockerImage()
      imageTag = localImageTag;
    } else if (!imageTag) {
      return {
        success: false,
        error: 'No image specified. Either skip --skip-build or provide --image-uri.',
      };
    }

    // Step 7: Request ECR credentials and repository from API
    // Credentials request is logged by apiClient.requestImageBuild()
    const imageBuildResponse = await apiClient.requestImageBuild({
      projectId: sanitizeProjectName(projectName),
      version: projectVersion,
      metadata: {
        elizaVersion: packageJson.dependencies?.['@elizaos/core'] || 'unknown',
        nodeVersion: process.version,
        deployedAt: new Date().toISOString(),
      },
    });

    if (!imageBuildResponse.success || !imageBuildResponse.data) {
      return {
        success: false,
        error: `Failed to get ECR credentials: ${imageBuildResponse.error}`,
      };
    }

    const imageBuildData = imageBuildResponse.data as ImageBuildResponse;

    // ECR repository already logged by apiClient.requestImageBuild()

    // Step 8: Push image to ECR
    logger.info({ src: 'cli', command: 'deploy-ecs' }, 'Pushing image to ECR');

    const pushResult = await pushDockerImage({
      imageTag: imageTag!,
      ecrRegistryUrl: imageBuildData.registryEndpoint,
      ecrAuthToken: imageBuildData.authToken,
      ecrImageUri: imageBuildData.ecrImageUri, // Use the full pre-constructed URI from API
    });

    if (!pushResult.success) {
      return {
        success: false,
        error: `Failed to push image to ECR: ${pushResult.error}`,
      };
    }

    logger.info({ src: 'cli', command: 'deploy-ecs' }, 'Image pushed to ECR');

    // Step 9: Clean up local images
    if (localImageTag) {
      await cleanupLocalImages([localImageTag]);
    }

    // Step 10: Parse environment variables
    const environmentVars = parseEnvironmentVariables(options.env);

    // Step 10.5: Check for existing deployment
    logger.info({ src: 'cli', command: 'deploy-ecs' }, 'Checking for existing deployments');
    const existingContainers = await apiClient.listContainers();
    let isUpdate = false;

    if (existingContainers.success && existingContainers.data) {
      const existingProject = existingContainers.data.find(
        (c: { project_name?: string }) => c.project_name === projectName
      );

      if (existingProject) {
        isUpdate = true;
        logger.info(
          {
            src: 'cli',
            command: 'deploy-ecs',
            projectName,
            containerId: existingProject.id,
            status: existingProject.status,
          },
          'Found existing project. This will be an UPDATE deployment'
        );
      } else {
        logger.info(
          { src: 'cli', command: 'deploy-ecs' },
          'No existing project found. This will be a FRESH deployment'
        );
      }
    }

    // Step 11: Determine architecture from Docker platform
    const detectedPlatform = await getDetectedPlatform(options.platform);
    const architecture = detectedPlatform.includes('arm64') ? 'arm64' : 'x86_64';

    logger.info(
      { src: 'cli', command: 'deploy-ecs', architecture, platform: detectedPlatform },
      'Target architecture'
    );

    // Step 12: Select instance type based on architecture
    const instanceDefaults = getInstanceDefaults(architecture);
    logger.info(
      {
        src: 'cli',
        command: 'deploy-ecs',
        instanceType: instanceDefaults.instanceType,
        architecture,
      },
      'AWS instance type'
    );

    // Step 13: Create container configuration for ECS
    const containerConfig: ContainerConfig = {
      name: containerName,
      project_name: projectName,
      description: packageJson.description || `ElizaOS project: ${containerName}`,
      ecr_image_uri: imageBuildData.ecrImageUri,
      ecr_repository_uri: imageBuildData.ecrRepositoryUri,
      image_tag: imageBuildData.ecrImageTag,
      port: options.port || 3000,
      desired_count: options.desiredCount || 1,
      cpu: options.cpu || instanceDefaults.cpu,
      memory: options.memory || instanceDefaults.memory,
      architecture,
      environment_vars: {
        ...environmentVars,
        PORT: (options.port || 3000).toString(),
        NODE_ENV: 'production',
      },
      health_check_path: '/health',
    };

    logger.info({ src: 'cli', command: 'deploy-ecs', isUpdate }, 'Deploying to AWS ECS');

    const createResponse = await apiClient.createContainer(containerConfig);

    if (!createResponse.success || !createResponse.data) {
      return {
        success: false,
        error: createResponse.error || 'Failed to create container',
      };
    }

    // Log credits info if present
    if ('creditsDeducted' in createResponse && 'creditsRemaining' in createResponse) {
      logger.info(
        {
          src: 'cli',
          command: 'deploy-ecs',
          creditsDeducted: createResponse.creditsDeducted,
          creditsRemaining: createResponse.creditsRemaining,
        },
        'Credits deducted'
      );
    }

    const containerId = createResponse.data.id;
    logger.info({ src: 'cli', command: 'deploy-ecs', containerId }, 'Container created');
    logger.info(
      {
        src: 'cli',
        command: 'deploy-ecs',
        url: `https://www.elizacloud.ai/dashboard/containers/${containerId}`,
      },
      'Track deployment'
    );

    // Step 12: Wait for deployment with beautiful progress spinner
    const deploymentSpinner = ora({
      text: 'Waiting for CloudFormation deployment to complete...',
      color: 'cyan',
    }).start();

    const startTime = Date.now();

    const deploymentResponse = await apiClient.waitForDeployment(containerId, {
      maxAttempts: 90, // 15 minutes
      intervalMs: 10000, // Poll every 10 seconds
      onProgress: (status: string, attempt: number, maxAttempts: number) => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

        // Status descriptions for better UX
        const statusDescriptions: Record<string, string> = {
          pending: 'Queueing deployment',
          building: 'Provisioning EC2 instance and ECS cluster',
          deploying: 'Deploying container and configuring load balancer',
          running: 'Container is running',
          failed: 'Deployment failed',
        };

        const description = statusDescriptions[status] || status;
        const percent = Math.floor((attempt / maxAttempts) * 100);

        deploymentSpinner.text = `${description}... [${timeStr}] (${percent}% of max wait time)`;
      },
    });

    if (!deploymentResponse.success) {
      const errorDetails = deploymentResponse.error || 'Deployment failed';
      deploymentSpinner.fail(`Deployment failed: ${errorDetails}`);

      logger.error({ src: 'cli', command: 'deploy-ecs' }, 'Troubleshooting tips:');
      logger.error(
        { src: 'cli', command: 'deploy-ecs' },
        '1. Check container status: elizaos containers list'
      );
      logger.error(
        { src: 'cli', command: 'deploy-ecs' },
        '2. View container logs: elizaos containers logs'
      );
      logger.error(
        { src: 'cli', command: 'deploy-ecs' },
        '3. Check CloudFormation console: https://console.aws.amazon.com/cloudformation'
      );
      logger.error(
        { src: 'cli', command: 'deploy-ecs' },
        '4. Verify Docker image runs locally: docker run <image>'
      );
      logger.error(
        { src: 'cli', command: 'deploy-ecs' },
        '5. Ensure health check endpoint returns 200 OK at /health'
      );

      return {
        success: false,
        containerId,
        error: errorDetails,
      };
    }

    const deploymentTime = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(deploymentTime / 60);
    const seconds = deploymentTime % 60;
    deploymentSpinner.succeed(`Deployment complete in ${minutes}m ${seconds}s`);

    if (!deploymentResponse.data) {
      return {
        success: false,
        containerId,
        error: 'Deployment succeeded but no container data returned',
      };
    }

    const container = deploymentResponse.data;

    // Step 13: Success!
    logger.info(
      { src: 'cli', command: 'deploy-ecs', containerId: container.id },
      'Deployment successful'
    );

    if (container.ecs_service_arn) {
      logger.info(
        { src: 'cli', command: 'deploy-ecs', ecsServiceArn: container.ecs_service_arn },
        'ECS Service'
      );
    }

    const deploymentUrl = container.load_balancer_url || container.deployment_url;

    if (deploymentUrl) {
      logger.info({ src: 'cli', command: 'deploy-ecs', url: deploymentUrl }, 'Deployment URL');
    }

    return {
      success: true,
      containerId: container.id,
      serviceArn: container.ecs_service_arn,
      taskDefinitionArn: container.ecs_task_definition_arn,
      url: deploymentUrl,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ src: 'cli', command: 'deploy-ecs', error: errorMessage }, 'Deployment error');
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
    path.join(cwd, '.env'),
    path.join(cwd, '.env.local'),
    path.join(cwd, '..', '.env'),
    path.join(cwd, '..', '.env.local'),
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      logger.debug({ src: 'cli', command: 'deploy-ecs', envPath }, 'Loaded environment');
    }
  }
}

/**
 * Check quota and credits before deployment
 */
async function checkQuotaAndCredits(apiClient: CloudApiClient): Promise<DeploymentResult> {
  const quotaResponse = await apiClient.getQuota();

  if (quotaResponse.success && quotaResponse.data) {
    const { quota, credits, pricing, billing } = quotaResponse.data;

    logger.info(
      {
        src: 'cli',
        command: 'deploy-ecs',
        current: quota.current,
        max: quota.max,
        remaining: quota.remaining,
      },
      'Container quota'
    );
    logger.info({ src: 'cli', command: 'deploy-ecs', balance: credits.balance }, 'Credit balance');

    // Display daily billing information if available
    if (billing) {
      logger.info(
        {
          src: 'cli',
          command: 'deploy-ecs',
          billingModel: billing.model,
          dailyCost: `$${billing.dailyCostPerContainer.toFixed(2)}/day`,
          monthlyCost: `$${billing.monthlyEquivalent.toFixed(2)}/month`,
        },
        'Container billing'
      );

      if (billing.runningContainers > 0) {
        logger.info(
          {
            src: 'cli',
            command: 'deploy-ecs',
            runningContainers: billing.runningContainers,
            currentDailyBurn: `$${billing.currentDailyBurn.toFixed(2)}/day`,
            daysOfRunway: billing.daysOfRunway ?? 'unlimited',
          },
          'Current usage'
        );
      }

      // Warn if low on runway
      if (billing.daysOfRunway !== null && billing.daysOfRunway < 7) {
        logger.warn(
          {
            src: 'cli',
            command: 'deploy-ecs',
            daysRemaining: billing.daysOfRunway,
            recommendedTopUp: `$${(billing.dailyCostPerContainer * 30).toFixed(2)}`,
          },
          'Low credit runway - consider adding funds'
        );
      }
    }

    if (quota.remaining === 0) {
      logger.warn(
        { src: 'cli', command: 'deploy-ecs', current: quota.current, max: quota.max },
        'Container limit reached'
      );
      return {
        success: false,
        error: `Container limit reached (${quota.max}). Delete unused containers or contact support.`,
      };
    }

    const totalCost = pricing.totalForNewContainer || 2000; // ECS deployments cost more
    if (credits.balance < totalCost) {
      logger.warn(
        { src: 'cli', command: 'deploy-ecs', required: totalCost, available: credits.balance },
        'Insufficient credits for deployment'
      );
      return {
        success: false,
        error: `Insufficient credits. Required: ${totalCost}, Available: ${credits.balance}`,
      };
    }

    logger.info(
      { src: 'cli', command: 'deploy-ecs', estimatedCost: totalCost },
      'Estimated deployment cost'
    );

    // Show ongoing costs after deployment
    if (billing) {
      const newDailyBurn = billing.currentDailyBurn + billing.dailyCostPerContainer;
      const newDaysOfRunway = Math.floor((credits.balance - totalCost) / newDailyBurn);
      logger.info(
        {
          src: 'cli',
          command: 'deploy-ecs',
          ongoingDailyCost: `$${newDailyBurn.toFixed(2)}/day`,
          projectedRunway: `${newDaysOfRunway} days`,
        },
        'Post-deployment costs'
      );
    }
  }

  return { success: true };
}

/**
 * Sanitize project name for use in URLs and identifiers
 */
function sanitizeProjectName(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new Error('Project name is required and must be a string');
  }

  let sanitized = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/\//g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');

  const MAX_NAME_LENGTH = 50;
  if (sanitized.length > MAX_NAME_LENGTH) {
    sanitized = sanitized.substring(0, MAX_NAME_LENGTH);
    sanitized = sanitized.replace(/-+$/, '');
    logger.warn(
      { src: 'cli', command: 'deploy-ecs', maxLength: MAX_NAME_LENGTH, truncated: sanitized },
      'Project name truncated'
    );
  }

  if (sanitized.startsWith('-')) {
    sanitized = sanitized.substring(1);
  }

  if (sanitized.length === 0) {
    throw new Error(
      `Project name '${name}' is invalid. Must contain at least one alphanumeric character.`
    );
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sanitized)) {
    throw new Error(`Sanitized project name '${sanitized}' failed final validation.`);
  }

  return sanitized;
}

/**
 * Parse and validate environment variables from CLI options
 */
function parseEnvironmentVariables(envOptions?: string[]): Record<string, string> {
  const environmentVars: Record<string, string> = {};

  if (!envOptions || envOptions.length === 0) {
    return environmentVars;
  }

  const MAX_ENV_VARS = 50;
  if (envOptions.length > MAX_ENV_VARS) {
    throw new Error(`Too many environment variables. Maximum ${MAX_ENV_VARS} allowed`);
  }

  for (let i = 0; i < envOptions.length; i++) {
    const envPair = envOptions[i];
    const equalIndex = envPair.indexOf('=');

    if (equalIndex === -1) {
      throw new Error(
        `Invalid environment variable format at position ${i + 1}: '${envPair}'. Expected KEY=VALUE`
      );
    }

    const key = envPair.substring(0, equalIndex);
    const value = envPair.substring(equalIndex + 1);

    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name at position ${i + 1}: '${key}'`);
    }

    if (value === '') {
      logger.warn(
        { src: 'cli', command: 'deploy-ecs', envVar: key },
        'Environment variable has an empty value'
      );
    }

    environmentVars[key] = value;
  }

  return environmentVars;
}

/**
 * Get the detected Docker platform from build or auto-detect
 */
async function getDetectedPlatform(platformOverride?: string): Promise<string> {
  // Priority: override > env var > auto-detect
  if (platformOverride) {
    return platformOverride;
  }

  if (process.env.ELIZA_DOCKER_PLATFORM) {
    return process.env.ELIZA_DOCKER_PLATFORM;
  }

  // Auto-detect based on host
  const arch = process.arch;
  if (arch === 'arm64') {
    return 'linux/arm64';
  } else if (arch === 'x64') {
    return 'linux/amd64';
  } else if (arch === 'arm') {
    return 'linux/arm/v7';
  }

  return 'linux/amd64'; // Default
}

/**
 * Get AWS instance defaults based on architecture
 * Maps architecture to appropriate AWS instance types and resource allocations
 */
function getInstanceDefaults(architecture: 'arm64' | 'x86_64'): {
  instanceType: string;
  cpu: number;
  memory: number;
} {
  if (architecture === 'arm64') {
    // t4g.small: 2 vCPUs, 2 GiB RAM (ARM Graviton2)
    // More cost-effective and energy-efficient
    return {
      instanceType: 't4g.small',
      cpu: 1792, // 1.75 vCPU (87.5% of 2 vCPUs)
      memory: 1792, // 1.75 GiB (87.5% of 2048 MB)
    };
  } else {
    // t3.small: 2 vCPUs, 2 GiB RAM (x86_64 Intel/AMD)
    // Note: AWS uses t3 (not t4) for small size on x86_64
    return {
      instanceType: 't3.small',
      cpu: 1792, // 1.75 vCPU (87.5% of 2 vCPUs)
      memory: 1792, // 1.75 GiB (87.5% of 2048 MB)
    };
  }
}

/**
 * Docker Build Utilities
 * Handles Docker image building and pushing to ECR
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import crypto from 'node:crypto';
import ora from 'ora';

export interface DockerBuildOptions {
  projectPath: string;
  dockerfile?: string;
  imageTag: string;
  buildArgs?: Record<string, string>;
  target?: string;
  // Optional platform override; defaults to host platform (auto-detected)
  // Can also be set via ELIZA_DOCKER_PLATFORM environment variable
  platform?: string;
}

export interface DockerBuildResult {
  success: boolean;
  imageTag: string;
  imageId?: string;
  size?: number;
  checksum?: string;
  error?: string;
}

export interface DockerPushOptions {
  imageTag: string; // Local image tag to push
  ecrRegistryUrl: string; // ECR registry endpoint (for login)
  ecrAuthToken: string; // ECR auth token
  ecrImageUri?: string; // Full ECR image URI from API (includes org/project path and tag)
}

export interface DockerPushResult {
  success: boolean;
  imageDigest?: string;
  repositoryUri?: string;
  error?: string;
}

/**
 * Check if Docker is installed and running
 */
export async function checkDockerAvailable(): Promise<boolean> {
  try {
    await execa('docker', ['--version']);
    await execa('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure Dockerfile exists, create from template if needed
 */
export async function ensureDockerfile(projectPath: string): Promise<string> {
  const dockerfilePath = path.join(projectPath, 'Dockerfile');

  if (fs.existsSync(dockerfilePath)) {
    logger.debug('Using existing Dockerfile');
    return dockerfilePath;
  }

  // Copy template Dockerfile
  logger.info('No Dockerfile found, creating from template...');

  const templatePath = path.join(__dirname, '../../../templates/Dockerfile.template');

  if (!fs.existsSync(templatePath)) {
    throw new Error('Dockerfile template not found');
  }

  fs.copyFileSync(templatePath, dockerfilePath);
  logger.info('Created Dockerfile from template');

  // Also copy .dockerignore if it doesn't exist
  const dockerignorePath = path.join(projectPath, '.dockerignore');
  if (!fs.existsSync(dockerignorePath)) {
    const dockerignoreTemplatePath = path.join(__dirname, '../../../templates/.dockerignore');

    if (fs.existsSync(dockerignoreTemplatePath)) {
      fs.copyFileSync(dockerignoreTemplatePath, dockerignorePath);
      logger.debug('Created .dockerignore from template');
    }
  }

  return dockerfilePath;
}

/**
 * Detect the host platform for Docker builds
 */
function detectHostPlatform(): string {
  const arch = process.arch;

  // Map Node.js arch to Docker platform
  // Node.js uses: 'arm64', 'x64', 'arm', 'ia32', etc.
  if (arch === 'arm64') {
    return 'linux/arm64';
  } else if (arch === 'x64') {
    return 'linux/amd64';
  } else if (arch === 'arm') {
    return 'linux/arm/v7';
  } else if (arch === 'ia32') {
    return 'linux/386';
  }

  // Default to amd64 for unknown architectures
  logger.warn(`Unknown architecture ${arch}, defaulting to linux/amd64`);
  return 'linux/amd64';
}

/**
 * Build Docker image
 */
export async function buildDockerImage(options: DockerBuildOptions): Promise<DockerBuildResult> {
  try {
    // Platform selection priority:
    // 1. Explicit option passed to function
    // 2. ELIZA_DOCKER_PLATFORM environment variable
    // 3. Host platform (auto-detected)
    const hostPlatform = detectHostPlatform();
    const platform = options.platform || process.env.ELIZA_DOCKER_PLATFORM || hostPlatform;

    // Warn if cross-compiling
    if (platform !== hostPlatform) {
      logger.warn(`Cross-compiling from ${hostPlatform} to ${platform}`);
      logger.warn('This may be slower and requires Docker BuildKit with QEMU emulation');
      logger.info('Tip: Set ELIZA_DOCKER_PLATFORM=' + hostPlatform + ' to use native platform');
    }

    logger.info(`Building Docker image: ${options.imageTag} (platform: ${platform})`);

    const dockerfilePath = options.dockerfile
      ? path.join(options.projectPath, options.dockerfile)
      : await ensureDockerfile(options.projectPath);

    if (!fs.existsSync(dockerfilePath)) {
      return {
        success: false,
        imageTag: options.imageTag,
        error: `Dockerfile not found: ${dockerfilePath}`,
      };
    }

    // Build Docker command arguments
    const buildArgs = ['build'];
    // Target platform
    buildArgs.push('--platform', platform);

    // Add build context
    buildArgs.push('-f', dockerfilePath);
    buildArgs.push('-t', options.imageTag);

    // Add build args if provided
    if (options.buildArgs) {
      for (const [key, value] of Object.entries(options.buildArgs)) {
        buildArgs.push('--build-arg', `${key}=${value}`);
      }
    }

    // Add target if specified
    if (options.target) {
      buildArgs.push('--target', options.target);
    }

    // Add context (project directory)
    buildArgs.push(options.projectPath);

    logger.debug('Docker build command:', `docker ${buildArgs.join(' ')}`);

    // Execute Docker build
    const startTime = Date.now();
    const { stdout } = await execa('docker', buildArgs, {
      env: {
        ...process.env,
        DOCKER_DEFAULT_PLATFORM: platform,
        DOCKER_BUILDKIT: '1',
      },
    });
    const buildTime = Date.now() - startTime;

    logger.debug('Docker build completed in', `${(buildTime / 1000).toFixed(2)}s`);

    // Log build output if verbose
    if (process.env.VERBOSE) {
      logger.debug('Build output:', stdout);
    }

    // Get image info
    const inspectResult = await execa('docker', [
      'inspect',
      options.imageTag,
      '--format={{.Id}}|{{.Size}}',
    ]);

    const [imageId, sizeStr] = inspectResult.stdout.split('|');
    const size = parseInt(sizeStr, 10);

    // Calculate checksum from image ID
    const checksum = crypto.createHash('sha256').update(imageId).digest('hex');

    logger.info(`✅ Image built: ${options.imageTag}`);
    logger.info(`   Size: ${(size / 1024 / 1024).toFixed(2)} MB`);

    return {
      success: true,
      imageTag: options.imageTag,
      imageId,
      size,
      checksum,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      success: false,
      imageTag: options.imageTag,
      error: errorMessage,
    };
  }
}

/**
 * Login to ECR registry
 */
async function loginToECR(registryUrl: string, authToken: string): Promise<void> {
  // Decode ECR auth token (it's base64 encoded username:password)
  const decoded = Buffer.from(authToken, 'base64').toString('utf-8');
  const [username, password] = decoded.split(':');

  // Strip https:// protocol if present - Docker login doesn't need it
  const cleanRegistryUrl = registryUrl.replace(/^https?:\/\//, '');

  logger.info(`Logging in to ECR registry: ${cleanRegistryUrl}`);

  // Docker login
  await execa('docker', ['login', '--username', username, '--password-stdin', cleanRegistryUrl], {
    input: password,
  });

  logger.info('✅ Logged in to ECR');
}

/**
 * Tag image for ECR
 */
async function tagImageForECR(localTag: string, ecrImageUri: string): Promise<void> {
  logger.info(`Tagging image for ECR: ${ecrImageUri}`);

  await execa('docker', ['tag', localTag, ecrImageUri]);

  logger.debug(`✅ Tagged: ${localTag} -> ${ecrImageUri}`);
}

/**
 * Push Docker image to ECR
 */
export async function pushDockerImage(options: DockerPushOptions): Promise<DockerPushResult> {
  try {
    logger.info(`Pushing image to ECR: ${options.imageTag}`);

    // Step 1: Login to ECR
    await loginToECR(options.ecrRegistryUrl, options.ecrAuthToken);

    // Step 2: Determine the ECR image URI to use
    let ecrImageUri: string;
    if (options.ecrImageUri) {
      // Use the pre-constructed full image URI from API (preferred)
      // Strip https:// protocol if present - Docker doesn't accept it in image tags
      ecrImageUri = options.ecrImageUri.replace(/^https?:\/\//, '');
      logger.debug(`Using API-provided ECR image URI: ${ecrImageUri}`);
    } else {
      // Legacy fallback: construct from registry + imageTag
      const cleanRegistryUrl = options.ecrRegistryUrl.replace(/^https?:\/\//, '');
      ecrImageUri = `${cleanRegistryUrl}/${options.imageTag}`;
      logger.debug(`Constructing ECR image URI from registry: ${ecrImageUri}`);
    }

    // Step 3: Tag local image for ECR
    await tagImageForECR(options.imageTag, ecrImageUri);

    // Step 4: Push to ECR with beautiful progress tracking
    const spinner = ora({
      text: 'Pushing to ECR...',
      color: 'cyan',
    }).start();

    const startTime = Date.now();
    let imageDigest: string | undefined;
    let completedLayers = 0;
    const layerProgress = new Map<string, { current: number; total: number }>();

    const pushProcess = execa('docker', ['push', ecrImageUri]);

    // Track progress from stderr (Docker outputs progress to stderr)
    if (pushProcess.stderr) {
      pushProcess.stderr.on('data', (data: Buffer) => {
        const output = data.toString();

        // Parse Docker layer progress
        // Format: "layer-id: Pushing [==>     ] 15.5MB/100MB"
        const lines = output.split('\n');

        for (const line of lines) {
          const layerMatch = line.match(
            /^([a-f0-9]+):\s*(\w+)\s*\[([=>]+)\s*\]\s+([\d.]+)([KMGT]?B)\/([\d.]+)([KMGT]?B)/
          );

          if (layerMatch) {
            const [, layerId, , , currentStr, currentUnit, totalStr, totalUnit] = layerMatch;

            // Convert to bytes for accurate progress
            const current = parseSize(currentStr, currentUnit);
            const total = parseSize(totalStr, totalUnit);

            layerProgress.set(layerId, { current, total });

            // Calculate overall progress
            let totalBytes = 0;
            let uploadedBytes = 0;

            for (const [, progress] of layerProgress) {
              totalBytes += progress.total;
              uploadedBytes += progress.current;
            }

            const overallPercent =
              totalBytes > 0 ? Math.floor((uploadedBytes / totalBytes) * 100) : 0;
            const uploadedMB = (uploadedBytes / 1024 / 1024).toFixed(1);
            const totalMB = (totalBytes / 1024 / 1024).toFixed(1);

            spinner.text = `Pushing to ECR... ${overallPercent}% (${uploadedMB}/${totalMB} MB, ${layerProgress.size} layers)`;
          }

          // Check for pushed layers
          if (line.includes(': Pushed')) {
            completedLayers++;
          }

          // Check for completion digest
          const digestMatch = line.match(/digest: (sha256:[a-f0-9]+)/);
          if (digestMatch) {
            imageDigest = digestMatch[1];
          }
        }
      });
    }

    try {
      await pushProcess;
      const pushTime = Date.now() - startTime;

      spinner.succeed(
        `Image pushed in ${(pushTime / 1000).toFixed(1)}s (${completedLayers} layers)`
      );
    } catch (error) {
      spinner.fail('Failed to push image to ECR');
      throw error;
    }

    return {
      success: true,
      imageDigest,
      repositoryUri: ecrImageUri,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Docker push failed:', errorMessage);

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Parse Docker size string to bytes
 */
function parseSize(value: string, unit: string): number {
  const num = parseFloat(value);
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  };
  return num * (multipliers[unit] || 1);
}

/**
 * Build and push Docker image in one operation
 */
export async function buildAndPushImage(
  buildOptions: DockerBuildOptions,
  pushOptions: DockerPushOptions
): Promise<{
  buildResult: DockerBuildResult;
  pushResult?: DockerPushResult;
}> {
  // Step 1: Build image
  const buildResult = await buildDockerImage(buildOptions);

  if (!buildResult.success) {
    return { buildResult };
  }

  // Step 2: Push image
  const pushResult = await pushDockerImage({
    ...pushOptions,
    imageTag: buildOptions.imageTag,
  });

  return { buildResult, pushResult };
}

/**
 * Clean up local Docker images
 */
export async function cleanupLocalImages(imageTags: string[]): Promise<void> {
  if (imageTags.length === 0) {
    return;
  }

  logger.info(`Cleaning up ${imageTags.length} local images...`);

  try {
    await execa('docker', ['rmi', ...imageTags, '--force']);
    logger.info('✅ Local images cleaned up');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to clean up some images:', errorMessage);
  }
}

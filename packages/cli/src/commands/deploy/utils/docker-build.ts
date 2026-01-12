/**
 * Docker Build Utilities
 * Handles Docker image building and pushing to ECR
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@elizaos/core';
import { bunExec } from '../../../utils/bun-exec';
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
    const versionResult = await bunExec('docker', ['--version']);
    if (!versionResult.success) return false;
    const infoResult = await bunExec('docker', ['info']);
    return infoResult.success;
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
    logger.debug({ src: 'cli', util: 'docker-build' }, 'Using existing Dockerfile');
    return dockerfilePath;
  }

  // Copy template Dockerfile
  logger.info({ src: 'cli', util: 'docker-build' }, 'No Dockerfile found, creating from template');

  const templatePath = path.join(__dirname, '../../../templates/Dockerfile.template');

  if (!fs.existsSync(templatePath)) {
    throw new Error('Dockerfile template not found');
  }

  fs.copyFileSync(templatePath, dockerfilePath);
  logger.info({ src: 'cli', util: 'docker-build' }, 'Created Dockerfile from template');

  // Also copy .dockerignore if it doesn't exist
  const dockerignorePath = path.join(projectPath, '.dockerignore');
  if (!fs.existsSync(dockerignorePath)) {
    const dockerignoreTemplatePath = path.join(__dirname, '../../../templates/.dockerignore');

    if (fs.existsSync(dockerignoreTemplatePath)) {
      fs.copyFileSync(dockerignoreTemplatePath, dockerignorePath);
      logger.debug({ src: 'cli', util: 'docker-build' }, 'Created .dockerignore from template');
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
  logger.warn(
    { src: 'cli', util: 'docker-build', arch },
    'Unknown architecture, defaulting to linux/amd64'
  );
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
      logger.warn(
        { src: 'cli', util: 'docker-build', hostPlatform, targetPlatform: platform },
        'Cross-compiling to different platform'
      );
      logger.warn(
        { src: 'cli', util: 'docker-build' },
        'This may be slower and requires Docker BuildKit with QEMU emulation'
      );
      logger.info(
        { src: 'cli', util: 'docker-build', nativePlatform: hostPlatform },
        'Tip: Set ELIZA_DOCKER_PLATFORM to use native platform'
      );
    }

    logger.info(
      { src: 'cli', util: 'docker-build', imageTag: options.imageTag, platform },
      'Building Docker image'
    );

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

    logger.debug(
      { src: 'cli', util: 'docker-build', command: `docker ${buildArgs.join(' ')}` },
      'Docker build command'
    );

    // Execute Docker build
    const startTime = Date.now();
    const buildResult = await bunExec('docker', buildArgs, {
      env: {
        DOCKER_DEFAULT_PLATFORM: platform,
        DOCKER_BUILDKIT: '1',
      },
    });

    if (!buildResult.success) {
      return {
        success: false,
        imageTag: options.imageTag,
        error: buildResult.stderr || 'Docker build failed',
      };
    }

    const stdout = buildResult.stdout;
    const buildTime = Date.now() - startTime;

    logger.debug(
      { src: 'cli', util: 'docker-build', buildTimeSeconds: (buildTime / 1000).toFixed(2) },
      'Docker build completed'
    );

    // Log build output if verbose
    if (process.env.VERBOSE) {
      logger.debug({ src: 'cli', util: 'docker-build', output: stdout }, 'Build output');
    }

    // Get image info
    const inspectResult = await bunExec('docker', [
      'inspect',
      options.imageTag,
      '--format={{.Id}}|{{.Size}}',
    ]);

    if (!inspectResult.success) {
      return {
        success: false,
        imageTag: options.imageTag,
        error: inspectResult.stderr || 'Failed to inspect Docker image',
      };
    }

    const [imageId, sizeStr] = inspectResult.stdout.split('|');
    const size = parseInt(sizeStr, 10);

    // Calculate checksum from image ID
    const checksum = crypto.createHash('sha256').update(imageId).digest('hex');

    logger.info(
      {
        src: 'cli',
        util: 'docker-build',
        imageTag: options.imageTag,
        sizeMB: (size / 1024 / 1024).toFixed(2),
      },
      'Image built successfully'
    );

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

  logger.info(
    { src: 'cli', util: 'docker-build', registry: cleanRegistryUrl },
    'Logging in to ECR registry'
  );

  // Docker login - use Bun.spawn directly for stdin input
  const proc = Bun.spawn(
    ['docker', 'login', '--username', username, '--password-stdin', cleanRegistryUrl],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  // Write password to stdin using FileSink API
  if (proc.stdin) {
    proc.stdin.write(password);
    proc.stdin.end();
  }

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Docker login failed: ${stderr}`);
  }

  logger.info({ src: 'cli', util: 'docker-build' }, 'Logged in to ECR');
}

/**
 * Tag image for ECR
 */
async function tagImageForECR(localTag: string, ecrImageUri: string): Promise<void> {
  logger.info({ src: 'cli', util: 'docker-build', ecrImageUri }, 'Tagging image for ECR');

  const result = await bunExec('docker', ['tag', localTag, ecrImageUri]);

  if (!result.success) {
    throw new Error(`Failed to tag image: ${result.stderr}`);
  }

  logger.debug({ src: 'cli', util: 'docker-build', localTag, ecrImageUri }, 'Image tagged for ECR');
}

/**
 * Push Docker image to ECR
 */
export async function pushDockerImage(options: DockerPushOptions): Promise<DockerPushResult> {
  try {
    logger.info(
      { src: 'cli', util: 'docker-build', imageTag: options.imageTag },
      'Pushing image to ECR'
    );

    // Step 1: Login to ECR
    await loginToECR(options.ecrRegistryUrl, options.ecrAuthToken);

    // Step 2: Determine the ECR image URI to use
    let ecrImageUri: string;
    if (options.ecrImageUri) {
      // Use the pre-constructed full image URI from API (preferred)
      // Strip https:// protocol if present - Docker doesn't accept it in image tags
      ecrImageUri = options.ecrImageUri.replace(/^https?:\/\//, '');
      logger.debug(
        { src: 'cli', util: 'docker-build', ecrImageUri },
        'Using API-provided ECR image URI'
      );
    } else {
      // Legacy fallback: construct from registry + imageTag
      const cleanRegistryUrl = options.ecrRegistryUrl.replace(/^https?:\/\//, '');
      ecrImageUri = `${cleanRegistryUrl}/${options.imageTag}`;
      logger.debug(
        { src: 'cli', util: 'docker-build', ecrImageUri },
        'Constructing ECR image URI from registry'
      );
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

    // Use Bun.spawn for the push process with streaming stderr
    const pushProcess = Bun.spawn(['docker', 'push', ecrImageUri], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Process stderr stream for progress tracking
    const processStderr = async () => {
      if (!pushProcess.stderr) return;

      const reader = pushProcess.stderr.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const output = decoder.decode(value, { stream: true });

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
        }
      } catch {
        // Ignore stream errors during processing
      }
    };

    try {
      // Process stderr in parallel with waiting for exit
      await Promise.all([processStderr(), pushProcess.exited]);

      const exitCode = pushProcess.exitCode;
      const pushTime = Date.now() - startTime;

      if (exitCode !== 0) {
        spinner.fail('Failed to push image to ECR');
        throw new Error('Docker push failed');
      }

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
    logger.error({ src: 'cli', util: 'docker-build', error: errorMessage }, 'Docker push failed');

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

  logger.info(
    { src: 'cli', util: 'docker-build', count: imageTags.length },
    'Cleaning up local images'
  );

  try {
    const result = await bunExec('docker', ['rmi', ...imageTags, '--force']);
    if (result.success) {
      logger.info({ src: 'cli', util: 'docker-build' }, 'Local images cleaned up');
    } else {
      logger.warn(
        { src: 'cli', util: 'docker-build', error: result.stderr },
        'Failed to clean up some images'
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(
      { src: 'cli', util: 'docker-build', error: errorMessage },
      'Failed to clean up some images'
    );
  }
}

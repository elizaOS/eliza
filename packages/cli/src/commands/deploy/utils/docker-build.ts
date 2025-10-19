/**
 * Docker Build Utilities
 * Handles Docker image building and pushing to ECR
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import crypto from 'node:crypto';

export interface DockerBuildOptions {
  projectPath: string;
  dockerfile?: string;
  imageTag: string;
  buildArgs?: Record<string, string>;
  target?: string;
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
  imageTag: string;
  ecrRegistryUrl: string;
  ecrAuthToken: string;
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
 * Build Docker image
 */
export async function buildDockerImage(options: DockerBuildOptions): Promise<DockerBuildResult> {
  try {
    logger.info(`Building Docker image: ${options.imageTag}`);

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
    const { stdout } = await execa('docker', buildArgs);
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
    logger.error('Docker build failed:', errorMessage);

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

  logger.info(`Logging in to ECR registry: ${registryUrl}`);

  // Docker login
  await execa('docker', ['login', '--username', username, '--password-stdin', registryUrl], {
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

    // Step 2: Tag for ECR (if not already tagged)
    const ecrImageUri = `${options.ecrRegistryUrl}/${options.imageTag}`;
    if (options.imageTag !== ecrImageUri) {
      await tagImageForECR(options.imageTag, ecrImageUri);
    }

    // Step 3: Push to ECR
    logger.info('Pushing to ECR (this may take a few minutes)...');
    const startTime = Date.now();

    const { stdout } = await execa('docker', ['push', ecrImageUri]);

    const pushTime = Date.now() - startTime;
    logger.info(`✅ Image pushed in ${(pushTime / 1000).toFixed(2)}s`);

    // Extract digest from push output
    const digestMatch = stdout.match(/digest: (sha256:[a-f0-9]+)/);
    const imageDigest = digestMatch ? digestMatch[1] : undefined;

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

/**
 * Docker build utilities for ElizaOS deployment
 */

import execa from "execa";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@elizaos/core";

export interface DockerBuildOptions {
  dockerfile: string;
  tag: string;
  context: string;
  platform?: string;
  buildArgs?: Record<string, string>;
}

export interface DockerBuildResult {
  success: boolean;
  imageId?: string;
  tag: string;
  error?: string;
}

export interface DockerExportResult {
  success: boolean;
  tarballPath?: string;
  size?: number;
  error?: string;
}

/**
 * Check if Docker is installed and running
 */
export async function checkDockerAvailable(): Promise<boolean> {
  try {
    await execa("docker", ["info"], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a Docker image
 */
export async function buildDockerImage(
  options: DockerBuildOptions,
): Promise<DockerBuildResult> {
  try {
    logger.info(`Building Docker image: ${options.tag}`);

    // Verify Dockerfile exists
    const dockerfilePath = path.resolve(options.context, options.dockerfile);
    if (!fs.existsSync(dockerfilePath)) {
      return {
        success: false,
        tag: options.tag,
        error: `Dockerfile not found: ${dockerfilePath}`,
      };
    }

    // Build arguments
    const buildArgs: string[] = ["build"];

    // Add platform if specified
    if (options.platform) {
      buildArgs.push("--platform", options.platform);
    }

    // Add build args
    if (options.buildArgs) {
      Object.entries(options.buildArgs).forEach(([key, value]) => {
        buildArgs.push("--build-arg", `${key}=${value}`);
      });
    }

    // Add tag
    buildArgs.push("-t", options.tag);

    // Add dockerfile location
    buildArgs.push("-f", options.dockerfile);

    // Add context
    buildArgs.push(options.context);

    // Execute docker build
    await execa("docker", buildArgs, {
      cwd: options.context,
      stdio: "inherit",
    });

    // Get image ID
    const inspectResult = await execa("docker", [
      "inspect",
      "--format={{.Id}}",
      options.tag,
    ]);

    const imageId = inspectResult.stdout.trim();

    logger.info(`✅ Docker image built successfully: ${options.tag}`);

    return {
      success: true,
      imageId,
      tag: options.tag,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown Docker build error";
    logger.error("Docker build failed:", errorMessage);
    return {
      success: false,
      tag: options.tag,
      error: errorMessage,
    };
  }
}

/**
 * Export Docker image to tarball for upload to Cloudflare
 */
export async function exportDockerImage(
  imageTag: string,
  outputPath?: string,
): Promise<DockerExportResult> {
  try {
    // Create temp directory if no output path specified
    const os = await import("node:os");
    const tempDir = outputPath || fs.mkdtempSync(path.join(os.tmpdir(), "eliza-deploy-"));
    const tarballPath = path.join(tempDir, "image.tar");

    logger.info(`📦 Exporting Docker image: ${imageTag}`);

    // Export image to tarball
    await execa("docker", ["save", "-o", tarballPath, imageTag], {
      stdio: "pipe",
    });

    // Get file size
    const stats = fs.statSync(tarballPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    logger.info(`✅ Image exported: ${tarballPath} (${sizeMB} MB)`);

    return {
      success: true,
      tarballPath,
      size: stats.size,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error(`Docker export failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Clean up exported image tarball
 */
export async function cleanupImageTarball(tarballPath: string): Promise<void> {
  try {
    if (fs.existsSync(tarballPath)) {
      fs.unlinkSync(tarballPath);
      logger.debug(`Cleaned up tarball: ${tarballPath}`);
    }
  } catch (error) {
    logger.warn(`Failed to cleanup tarball: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Generate a default Dockerfile if none exists
 */
export function generateDefaultDockerfile(projectPath: string): string {
  const dockerfileContent = `# ElizaOS Project Dockerfile
FROM node:20-alpine

# Install build dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY bun.lockb* ./

# Install dependencies
RUN npm install -g bun
RUN bun install --production

# Copy project files
COPY . .

# Build the project
RUN bun run build || true

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \\
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error('unhealthy')})"

# Start the application
CMD ["bun", "run", "start"]
`;

  const dockerfilePath = path.join(projectPath, "Dockerfile");
  fs.writeFileSync(dockerfilePath, dockerfileContent);

  logger.info(`✅ Created default Dockerfile at ${dockerfilePath}`);

  return "Dockerfile";
}

/**
 * Push Docker image to a registry
 */
export async function pushDockerImage(tag: string): Promise<boolean> {
  try {
    logger.info(`Pushing Docker image: ${tag}`);

    await execa("docker", ["push", tag], {
      stdio: "inherit",
    });

    logger.info(`✅ Docker image pushed successfully: ${tag}`);

    return true;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("Docker push failed:", errorMessage);
    return false;
  }
}

/**
 * Tag a Docker image
 */
export async function tagDockerImage(
  sourceTag: string,
  targetTag: string,
): Promise<boolean> {
  try {
    await execa("docker", ["tag", sourceTag, targetTag]);
    logger.info(`✅ Tagged image ${sourceTag} as ${targetTag}`);
    return true;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("Docker tag failed:", errorMessage);
    return false;
  }
}


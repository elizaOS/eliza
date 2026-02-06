/**
 * AWS ECR (Elastic Container Registry) Integration
 * Handles Docker image storage and management
 */

import {
  ECRClient,
  CreateRepositoryCommand,
  GetAuthorizationTokenCommand,
  DescribeRepositoriesCommand,
  DescribeImagesCommand,
  BatchDeleteImageCommand,
  PutLifecyclePolicyCommand,
  RepositoryNotFoundException,
  RepositoryAlreadyExistsException,
  type Repository,
  type ImageIdentifier,
  type AuthorizationData,
} from "@aws-sdk/client-ecr";
import { logger } from "@/lib/utils/logger";

/**
 * Configuration for ECR client
 */
/**
 * Configuration for ECR client.
 */
export interface ECRConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Result of image push operation
 */
/**
 * Result of pushing an image to ECR.
 */
export interface ImagePushResult {
  repositoryUri: string;
  imageUri: string;
  imageDigest?: string;
  imageTag: string;
}

/**
 * Repository creation result
 */
/**
 * Result of creating an ECR repository.
 */
export interface RepositoryResult {
  repositoryUri: string;
  repositoryArn: string;
  registryId: string;
}

/**
 * AWS ECR Manager for handling container image operations
 */
export class ECRManager {
  private client: ECRClient;
  private config: ECRConfig;

  constructor(config: ECRConfig) {
    this.config = config;
    this.client = new ECRClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /**
   * Create a new ECR repository if it doesn't exist
   */
  async createRepository(repositoryName: string): Promise<RepositoryResult> {
    // Check if repository exists
    // Note: DescribeRepositoriesCommand throws RepositoryNotFoundException if repo doesn't exist
    try {
      const describeCommand = new DescribeRepositoriesCommand({
        repositoryNames: [repositoryName],
      });

      const describeResponse = await this.client.send(describeCommand);
      const repository = describeResponse.repositories?.[0];

      if (repository) {
        logger.info("Repository already exists:", repository.repositoryUri);
        return {
          repositoryUri: repository.repositoryUri!,
          repositoryArn: repository.repositoryArn!,
          registryId: repository.registryId!,
        };
      }
    } catch (error: unknown) {
      // RepositoryNotFoundException is expected when repo doesn't exist - proceed to create it
      // AWS SDK v3 uses class-based errors, so we check with instanceof first
      const isNotFoundError =
        error instanceof RepositoryNotFoundException ||
        (error instanceof Error &&
          (error.name === "RepositoryNotFoundException" ||
            error.message.includes("does not exist")));

      if (!isNotFoundError) {
        // Re-throw unexpected errors
        logger.error("Unexpected error checking repository:", {
          errorName: error instanceof Error ? error.name : "Unknown",
          errorMessage: error instanceof Error ? error.message : String(error),
          repositoryName,
        });
        throw error;
      }

      logger.info("Repository does not exist, will create:", repositoryName);
    }

    logger.info("Creating new ECR repository:", repositoryName);
    try {
      const createCommand = new CreateRepositoryCommand({
        repositoryName,
        imageScanningConfiguration: {
          scanOnPush: true,
        },
        imageTagMutability: "MUTABLE",
        encryptionConfiguration: {
          encryptionType: "AES256",
        },
      });

      const createResponse = await this.client.send(createCommand);
      const createdRepository = createResponse.repository!;

      logger.info("Repository created:", createdRepository.repositoryUri);

      // Set lifecycle policy to prevent storage bloat
      await this.setLifecyclePolicy(repositoryName);

      return {
        repositoryUri: createdRepository.repositoryUri!,
        repositoryArn: createdRepository.repositoryArn!,
        registryId: createdRepository.registryId!,
      };
    } catch (createError: unknown) {
      // If repository already exists (race condition), try to get it again
      if (
        createError instanceof RepositoryAlreadyExistsException ||
        (createError instanceof Error &&
          (createError.name === "RepositoryAlreadyExistsException" ||
            createError.message.includes("already exists")))
      ) {
        logger.info(
          "Repository was created by another process, fetching:",
          repositoryName,
        );
        const existingRepo = await this.getRepository(repositoryName);
        if (existingRepo) {
          return {
            repositoryUri: existingRepo.repositoryUri!,
            repositoryArn: existingRepo.repositoryArn!,
            registryId: existingRepo.registryId!,
          };
        }
      }

      logger.error("Failed to create ECR repository:", {
        errorName: createError instanceof Error ? createError.name : "Unknown",
        errorMessage:
          createError instanceof Error
            ? createError.message
            : String(createError),
        repositoryName,
      });
      throw createError;
    }
  }

  /**
   * Set lifecycle policy to automatically clean up old images
   * Keeps last 10 images per repository to prevent storage costs from exploding
   */
  async setLifecyclePolicy(repositoryName: string): Promise<void> {
    const policy = {
      rules: [
        {
          rulePriority: 1,
          description: "Keep last 10 tagged images only",
          selection: {
            tagStatus: "tagged",
            tagPrefixList: ["v", "latest", "prod", "staging"],
            countType: "imageCountMoreThan",
            countNumber: 10,
          },
          action: {
            type: "expire",
          },
        },
        {
          rulePriority: 2,
          description: "Delete untagged images after 7 days",
          selection: {
            tagStatus: "untagged",
            countType: "sinceImagePushed",
            countUnit: "days",
            countNumber: 7,
          },
          action: {
            type: "expire",
          },
        },
        {
          rulePriority: 3,
          description: "Keep last 3 images for all other tags",
          selection: {
            tagStatus: "any",
            countType: "imageCountMoreThan",
            countNumber: 3,
          },
          action: {
            type: "expire",
          },
        },
      ],
    };

    const command = new PutLifecyclePolicyCommand({
      repositoryName,
      lifecyclePolicyText: JSON.stringify(policy),
    });

    await this.client.send(command);
    logger.info(
      `✅ ECR lifecycle policy set for repository: ${repositoryName}`,
    );
  }

  /**
   * Get Docker login credentials for ECR
   */
  async getAuthorizationToken(): Promise<AuthorizationData> {
    const command = new GetAuthorizationTokenCommand({});
    const response = await this.client.send(command);

    const authData = response.authorizationData?.[0];
    if (!authData || !authData.authorizationToken) {
      throw new Error("Failed to get ECR authorization token");
    }

    return authData;
  }

  /**
   * Get the full image URI for a repository and tag
   */
  getImageUri(repositoryUri: string, tag: string): string {
    return `${repositoryUri}:${tag}`;
  }

  /**
   * List images in a repository
   */
  async listImages(repositoryName: string): Promise<ImageIdentifier[]> {
    const command = new DescribeImagesCommand({
      repositoryName,
    });

    const response = await this.client.send(command);
    return (
      response.imageDetails?.map((detail) => ({
        imageDigest: detail.imageDigest,
        imageTag: detail.imageTags?.[0],
      })) || []
    );
  }

  /**
   * Delete images from a repository
   */
  async deleteImages(
    repositoryName: string,
    imageIds: ImageIdentifier[],
  ): Promise<void> {
    if (imageIds.length === 0) {
      return;
    }

    const command = new BatchDeleteImageCommand({
      repositoryName,
      imageIds,
    });

    await this.client.send(command);
    logger.info(`Deleted ${imageIds.length} images from ${repositoryName}`);
  }

  /**
   * Get repository details
   */
  async getRepository(repositoryName: string): Promise<Repository | null> {
    const command = new DescribeRepositoriesCommand({
      repositoryNames: [repositoryName],
    });

    const response = await this.client.send(command);
    return response.repositories?.[0] || null;
  }

  /**
   * Generate repository name from project details
   * Includes project name for multi-project support per user
   */
  static generateRepositoryName(
    organizationId: string,
    userId: string,
    projectName: string,
  ): string {
    // ECR repository names must be lowercase and support multiple projects per user
    const sanitized = `${organizationId}/${userId}/${projectName}`
      .toLowerCase()
      .replace(/[^a-z0-9/_-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-");

    return `elizaos/${sanitized}`;
  }

  /**
   * Decode ECR authorization token
   */
  static decodeAuthToken(authorizationToken: string): {
    username: string;
    password: string;
  } {
    const decoded = Buffer.from(authorizationToken, "base64").toString("utf-8");
    const [username, password] = decoded.split(":");
    return { username, password };
  }

  /**
   * Get registry hostname from repository URI
   */
  static getRegistryHostname(repositoryUri: string): string {
    return repositoryUri.split("/")[0];
  }

  /**
   * Verify that an ECR image exists before attempting deployment
   * Critical for preventing failed deployments due to missing images
   */
  async verifyImageExists(imageUri: string): Promise<boolean> {
    // Parse image URI: registry/repository:tag
    const [repoWithRegistry, tag] = imageUri.split(":");
    const repositoryName = repoWithRegistry.split("/").slice(1).join("/");

    if (!tag) {
      throw new Error("Image URI must include a tag");
    }

    const command = new DescribeImagesCommand({
      repositoryName,
      imageIds: [{ imageTag: tag }],
    });

    const response = await this.client.send(command);
    return !!(response.imageDetails && response.imageDetails.length > 0);
  }
}

/**
 * Get ECR manager instance with configuration from environment
 */
export function getECRManager(): ECRManager {
  const region = process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS ECR configuration missing. Required: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY",
    );
  }

  return new ECRManager({
    region,
    accessKeyId,
    secretAccessKey,
  });
}

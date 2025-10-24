/**
 * Deploy Command Types
 * Types for deploying ElizaOS projects to AWS ECS
 */

export interface DeployOptions {
  name?: string;
  port?: number;
  desiredCount?: number; // Replaces maxInstances
  cpu?: number; // CPU units (1792 = 1.75 vCPU, 87.5% of t3g.small)
  memory?: number; // Memory in MB (1792 = 1.75 GB, 87.5% of t3g.small)
  apiKey?: string;
  apiUrl?: string;
  env?: string[];
  skipBuild?: boolean; // Skip Docker build (use existing image)
  imageUri?: string; // Use existing ECR image URI
}

export interface DeploymentResult {
  success: boolean;
  containerId?: string;
  serviceArn?: string; // ECS service ARN
  taskDefinitionArn?: string; // ECS task definition ARN
  url?: string; // Load balancer URL
  error?: string;
}

export interface ContainerConfig {
  name: string;
  description?: string;
  port: number;
  desired_count: number; // Number of tasks to run
  cpu: number; // CPU units (1792 = 1.75 vCPU, 87.5% of t3g.small)
  memory: number; // Memory in MB (1792 = 1.75 GB, 87.5% of t3g.small)
  environment_vars?: Record<string, string>;
  health_check_path: string;
  ecr_image_uri: string; // Full ECR image URI with tag
  ecr_repository_uri?: string; // ECR repository URI
  image_tag?: string; // Image tag (e.g., "latest", "v1.0.0")
}

/**
 * Base API response structure
 */
export interface CloudApiResponseBase {
  success: boolean;
  error?: string;
  message?: string;
}

/**
 * API response for successful operations with data
 */
export interface CloudApiSuccessResponse<T> extends CloudApiResponseBase {
  success: true;
  data: T;
  error?: never;
}

/**
 * API response for failed operations
 */
export interface CloudApiErrorResponse extends CloudApiResponseBase {
  success: false;
  data?: never;
  error: string;
  details?: Record<string, unknown>;
}

/**
 * API response with credit information
 */
export interface CloudApiResponseWithCredits<T> extends CloudApiSuccessResponse<T> {
  creditsDeducted: number;
  creditsRemaining: number;
}

/**
 * API response for quota checks
 */
export interface CloudApiQuotaResponse extends CloudApiSuccessResponse<QuotaInfo> {
  data: QuotaInfo;
}

/**
 * Generic API response type (union of success and error)
 */
export type CloudApiResponse<T = unknown> =
  | CloudApiSuccessResponse<T>
  | CloudApiErrorResponse
  | CloudApiResponseWithCredits<T>;

/**
 * Quota information for container deployments
 */
export interface QuotaInfo {
  quota: {
    max: number;
    current: number;
    remaining: number;
  };
  credits: {
    balance: number;
  };
  pricing: {
    totalForNewContainer: number;
    imageUpload?: number;
    containerDeployment?: number;
  };
}

/**
 * Image upload response data
 */
export interface ImageUploadData {
  imageId: string;
  digest: string;
  size: number;
}

/**
 * Container data from API
 */
export interface ContainerData {
  id: string;
  name: string;
  status: string;
  ecs_service_arn?: string;
  ecs_task_definition_arn?: string;
  load_balancer_url?: string;
  deployment_url?: string;
  error_message?: string;
  created_at?: string;
  updated_at?: string;
  port?: number;
  desired_count?: number;
  cpu?: number;
  memory?: number;
  environment_vars?: Record<string, string>;
  health_check_path?: string;
}

/**
 * Image build and push request
 */
export interface ImageBuildRequest {
  projectId: string;
  version: string;
  metadata?: Record<string, string>;
}

/**
 * Image build and push response from Cloud API
 * Returns ECR repository and authentication information
 */
export interface ImageBuildResponse {
  ecrRepositoryUri: string;
  ecrImageUri: string; // Full image URI with tag
  ecrImageTag: string;
  authToken: string; // ECR authorization token for Docker login
  authTokenExpiresAt: string;
  registryEndpoint: string;
}

/**
 * Docker build context
 */
export interface DockerBuildContext {
  projectPath: string;
  dockerfile?: string;
  buildArgs?: Record<string, string>;
  target?: string;
}

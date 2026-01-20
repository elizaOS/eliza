/**
 * Deploy Command Types
 * Types for deploying ElizaOS projects to AWS ECS
 */

export interface DeployOptions {
  name?: string;
  projectName?: string; // Project name for multi-project support
  port?: number;
  desiredCount?: number; // Replaces maxInstances
  cpu?: number; // CPU units (1792 = 1.75 vCPU, 87.5% of t4g.small)
  memory?: number; // Memory in MB (1792 MB = 1.75 GiB, 87.5% of t4g.small 2 GiB)
  apiKey?: string;
  apiUrl?: string;
  env?: string[];
  skipBuild?: boolean; // Skip Docker build (use existing image)
  imageUri?: string; // Use existing ECR image URI
  platform?: string; // Docker platform (e.g., linux/amd64, linux/arm64)
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
  project_name: string; // Project identifier for multi-project support
  description?: string;
  port: number;
  desired_count: number; // Number of tasks to run
  cpu: number; // CPU units (1792 = 1.75 vCPU, 87.5% of t4g.small)
  memory: number; // Memory in MB (1792 MB = 1.75 GiB, 87.5% of t4g.small 2 GiB)
  environment_vars?: Record<string, string>;
  health_check_path: string;
  ecr_image_uri: string; // Full ECR image URI with tag
  ecr_repository_uri?: string; // ECR repository URI
  image_tag?: string; // Image tag (e.g., "latest", "v1.0.0")
  architecture?: 'arm64' | 'x86_64'; // CPU architecture for AWS instance selection
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
export type CloudApiResponse<
  T = Record<string, string | number | boolean | null> | string | number | boolean | null,
> = CloudApiSuccessResponse<T> | CloudApiErrorResponse | CloudApiResponseWithCredits<T>;

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
  billing?: {
    model: 'daily';
    dailyCostPerContainer: number;
    monthlyEquivalent: number;
    currentDailyBurn: number;
    runningContainers: number;
    daysOfRunway: number | null;
    warningThreshold: number;
    shutdownWarningHours: number;
  };
  pricing: {
    totalForNewContainer: number;
    imageUpload?: number;
    containerDeployment?: number;
    perDay?: number;
    perMonth?: number;
  };
}

/**
 * Container data from API
 */
export interface ContainerData {
  id: string;
  name: string;
  project_name: string; // Project identifier
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
  is_update?: string; // "true" if update, "false" if fresh
  cloudformation_stack_name?: string; // Stack name
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

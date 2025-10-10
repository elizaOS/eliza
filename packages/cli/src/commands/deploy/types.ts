/**
 * Deploy Command Types
 * Types for deploying ElizaOS projects to Cloudflare Containers
 */

export interface DeployOptions {
  name?: string;
  port?: number;
  maxInstances?: number;
  apiKey?: string;
  apiUrl?: string;
  dockerfile?: string;
  env?: string[];
  build?: boolean;
  tag?: string;
}

export interface DeploymentResult {
  success: boolean;
  containerId?: string;
  workerId?: string;
  url?: string;
  error?: string;
}

export interface ContainerConfig {
  name: string;
  description?: string;
  image_tag?: string;
  dockerfile_path?: string;
  port: number;
  max_instances: number;
  environment_vars?: Record<string, string>;
  health_check_path: string;
}

export interface CloudApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  creditsDeducted?: number;
  creditsRemaining?: number;
  requiredCredits?: number;
  availableCredits?: number;
  limit?: number;
  current?: number;
}

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
  cloudflare_worker_id?: string;
  deployment_url?: string;
  cloudflare_url?: string;
  error_message?: string;
  created_at?: string;
  updated_at?: string;
  port?: number;
  max_instances?: number;
  environment_vars?: Record<string, string>;
  health_check_path?: string;
}

/**
 * Extended CloudApiResponse with credits info
 */
export interface CloudApiResponseWithCredits<T = unknown> extends CloudApiResponse<T> {
  creditsDeducted: number;
  creditsRemaining: number;
}


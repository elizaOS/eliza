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
  env?: string[];
  skipArtifact?: boolean; // Skip artifact creation (use existing)
  artifactPath?: string; // Path to existing artifact
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
  port: number;
  max_instances: number;
  environment_vars?: Record<string, string>;
  health_check_path: string;
  use_bootstrapper?: boolean; // Use bootstrapper image
  artifact_url?: string; // Presigned download URL to artifact in R2 (expires in 1 hour)
  artifact_id?: string; // Artifact ID for reference tracking
  artifact_checksum?: string; // SHA256 checksum of artifact
  image_tag?: string; // Optional: custom bootstrapper image tag
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
 * Artifact upload request
 */
export interface ArtifactUploadRequest {
  projectId: string;
  version: string;
  checksum: string;
  size: number;
  metadata?: Record<string, string>;
}

/**
 * Artifact upload response from Cloud API
 * Updated to match Cloud API v1 response format
 * 
 * SECURITY: Raw credentials have been removed from this interface.
 * The API no longer returns temporary AWS credentials to reduce attack surface.
 * Use the presigned URLs (upload.url and download.url) which contain all
 * necessary authentication embedded in the URL itself.
 */
export interface ArtifactUploadResponse {
  artifactId: string;
  upload: {
    url: string;
    method: "PUT";
    expiresAt: string;
  };
  download: {
    url: string;
    method: "GET";
    expiresAt: string;
  };
  artifact: {
    id: string;
    version: string;
    checksum: string;
    size: number;
    r2Key?: string;
    r2Url?: string;
  };
}

/**
 * Artifact metadata stored in database
 */
export interface ArtifactMetadata {
  id: string;
  organizationId: string;
  projectId: string;
  version: string;
  checksum: string;
  size: number;
  r2Key: string;
  r2Url: string;
  metadata?: Record<string, string>;
  createdAt: Date;
  createdBy: string;
}

/**
 * Deployment mode
 */
export type DeploymentMode = "docker" | "bootstrapper";

/**
 * Bootstrapper deployment config
 */
export interface BootstrapperConfig {
  artifactUrl: string;
  artifactChecksum: string;
  startCommand?: string;
  skipBuild?: boolean;
  envVars?: Record<string, string>;
}


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

export interface CloudApiResponse<T = any> {
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


/**
 * ElizaOS Cloud API Client
 * Handles communication with the ElizaOS Cloud backend for deployments
 */

import { logger } from '@elizaos/core';
import type {
  ContainerConfig,
  CloudApiResponse,
  CloudApiErrorResponse,
  QuotaInfo,
  ContainerData,
} from '../types';

export interface ApiClientOptions {
  apiKey: string;
  apiUrl: string;
}

export class CloudApiClient {
  private apiKey: string;
  private apiUrl: string;
  private readonly DEFAULT_TIMEOUT_MS = 30000; // 30 seconds default timeout

  constructor(options: ApiClientOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  /**
   * Fetch with timeout helper
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number = this.DEFAULT_TIMEOUT_MS
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `Request timeout after ${timeoutMs}ms. Please check your network connection.`
        );
      }
      throw error;
    }
  }

  /**
   * Parse API error response with support for multiple formats
   */
  private async parseErrorResponse(response: Response): Promise<string> {
    const contentType = response.headers.get('content-type');

    try {
      if (contentType?.includes('application/json')) {
        const json = await response.json();
        // Handle multiple error formats from Cloud API
        return json.error || json.message || JSON.stringify(json);
      }
      return await response.text();
    } catch {
      return `HTTP ${response.status} ${response.statusText}`;
    }
  }

  /**
   * Handle API errors consistently
   */
  private handleApiError(operation: string, error: unknown): CloudApiErrorResponse {
    const errorMessage = error instanceof Error ? error.message : 'Unknown API error';
    logger.error(
      { src: 'cli', util: 'api-client', operation, error: errorMessage },
      'API operation failed'
    );

    return {
      success: false,
      error: errorMessage,
      details: error instanceof Error ? { name: error.name, stack: error.stack } : undefined,
    };
  }

  /**
   * Get container quota and pricing information
   */
  async getQuota(): Promise<CloudApiResponse<QuotaInfo>> {
    try {
      const response = await this.fetchWithTimeout(`${this.apiUrl}/api/v1/containers/quota`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        throw new Error(`API request failed (${response.status}): ${error}`);
      }

      const data = await response.json();

      // Validate response structure
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid API response format');
      }

      return data as CloudApiResponse<QuotaInfo>;
    } catch (error: unknown) {
      return this.handleApiError('get quota', error);
    }
  }

  /**
   * Create a new container deployment
   */
  async createContainer(config: ContainerConfig): Promise<CloudApiResponse<ContainerData>> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.apiUrl}/api/v1/containers`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(config),
        },
        60000 // 60s timeout - API returns immediately (202 Accepted), no need to wait
      );

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);

        // Handle specific HTTP status codes
        if (response.status === 402) {
          throw new Error(`Insufficient credits: ${error}`);
        } else if (response.status === 403) {
          throw new Error(`Quota exceeded: ${error}`);
        } else if (response.status === 409) {
          throw new Error(`Container name conflict: ${error}`);
        }

        throw new Error(`API request failed (${response.status}): ${error}`);
      }

      return await response.json();
    } catch (error: unknown) {
      return this.handleApiError('create container', error);
    }
  }

  /**
   * List all containers for the authenticated user
   */
  async listContainers(): Promise<CloudApiResponse<ContainerData[]>> {
    try {
      const response = await this.fetchWithTimeout(`${this.apiUrl}/api/v1/containers`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        throw new Error(`API request failed (${response.status}): ${error}`);
      }

      return await response.json();
    } catch (error: unknown) {
      return this.handleApiError('list containers', error);
    }
  }

  /**
   * Get container status
   */
  async getContainer(containerId: string): Promise<CloudApiResponse<ContainerData>> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.apiUrl}/api/v1/containers/${containerId}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        }
      );

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        throw new Error(`API request failed (${response.status}): ${error}`);
      }

      return await response.json();
    } catch (error: unknown) {
      return this.handleApiError('get container status', error);
    }
  }

  /**
   * Delete a container
   */
  async deleteContainer(containerId: string): Promise<CloudApiResponse> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.apiUrl}/api/v1/containers/${containerId}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed (${response.status}): ${error}`);
      }

      return await response.json();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown API error';
      logger.error(
        { src: 'cli', util: 'api-client', error: errorMessage },
        'Failed to delete container'
      );
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Poll container status until it reaches a terminal state
   * Matches Cloud API deployment timeout of 10 minutes
   */
  async waitForDeployment(
    containerId: string,
    options: {
      maxAttempts?: number;
      intervalMs?: number;
      onProgress?: (status: string, attempt: number, maxAttempts: number) => void;
    } = {}
  ): Promise<CloudApiResponse<ContainerData>> {
    // CloudFormation deployments take 8-12 minutes typically
    // Default: 90 attempts * 10s = 900s = 15 minutes (with buffer)
    const maxAttempts = options.maxAttempts || 90;
    const intervalMs = options.intervalMs || 10000;

    for (let i = 0; i < maxAttempts; i++) {
      const response = await this.getContainer(containerId);

      if (!response.success) {
        return response;
      }

      const status = response.data?.status;

      // Call progress callback if provided
      if (options.onProgress) {
        options.onProgress(status || 'unknown', i + 1, maxAttempts);
      }

      // Success terminal state
      if (status === 'running') {
        return response;
      }

      // Failure terminal states
      if (status === 'failed') {
        return {
          success: false,
          error: response.data?.error_message || 'Deployment failed',
        };
      }

      // Stopped/deleted states (unexpected during deployment)
      if (status === 'stopped' || status === 'deleting' || status === 'deleted') {
        return {
          success: false,
          error: `Deployment interrupted - container is ${status}`,
        };
      }

      // In-progress states: pending, building, deploying
      // Wait before next check
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    // Timeout reached
    const totalMinutes = (maxAttempts * intervalMs) / 60000;
    return {
      success: false,
      error: `Deployment timeout after ${totalMinutes} minutes. Container may still be deploying - check "elizaos containers list" for current status.`,
    };
  }

  /**
   * Request ECR credentials and repository for image build
   */
  async requestImageBuild(request: {
    projectId: string;
    version: string;
    metadata?: Record<string, string>;
  }): Promise<CloudApiResponse<any>> {
    try {
      logger.info({ src: 'cli', util: 'api-client' }, 'Requesting ECR credentials');

      const response = await this.fetchWithTimeout(`${this.apiUrl}/api/v1/containers/credentials`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId: request.projectId,
          version: request.version,
          metadata: request.metadata,
        }),
      });

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        throw new Error(`Failed to get ECR credentials (${response.status}): ${error}`);
      }

      const data = await response.json();

      if (!data.success || !data.data) {
        throw new Error(data.error || 'Failed to get ECR credentials');
      }

      // Validate response structure
      if (!data.data.ecrRepositoryUri || !data.data.authToken) {
        throw new Error('Invalid response: missing ECR credentials');
      }

      logger.info({ src: 'cli', util: 'api-client' }, 'Received ECR credentials');
      logger.info(
        { src: 'cli', util: 'api-client', ecrRepositoryUri: data.data.ecrRepositoryUri },
        'ECR repository'
      );
      return data;
    } catch (error: unknown) {
      return this.handleApiError('request image build credentials', error);
    }
  }
}

/**
 * Get API credentials from environment or config
 */
export function getApiCredentials(): {
  apiKey: string;
  apiUrl: string;
} | null {
  const apiKey = process.env.ELIZAOS_API_KEY;
  const apiUrl = process.env.ELIZAOS_API_URL || 'https://www.elizacloud.ai';

  if (!apiKey) {
    return null;
  }

  return { apiKey, apiUrl };
}

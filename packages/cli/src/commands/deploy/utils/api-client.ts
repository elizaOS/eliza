/**
 * ElizaOS Cloud API Client
 * Handles communication with the ElizaOS Cloud backend for deployments
 */

import { logger } from "@elizaos/core";
import type {
  ContainerConfig,
  CloudApiResponse,
  QuotaInfo,
  ContainerData,
  ArtifactUploadRequest,
  ArtifactUploadResponse,
} from "../types";

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
    this.apiUrl = options.apiUrl.replace(/\/$/, ""); // Remove trailing slash
  }

  /**
   * Fetch with timeout helper
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number = this.DEFAULT_TIMEOUT_MS,
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
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timeout after ${timeoutMs}ms. Please check your network connection.`);
      }
      throw error;
    }
  }

  /**
   * Get container quota and pricing information
   */
  async getQuota(): Promise<CloudApiResponse<QuotaInfo>> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.apiUrl}/api/v1/containers/quota`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed (${response.status}): ${error}`);
      }

      return await response.json();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown API error";
      logger.error("Failed to get quota:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }


  /**
   * Create a new container deployment
   */
  async createContainer(
    config: ContainerConfig,
  ): Promise<CloudApiResponse<ContainerData>> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.apiUrl}/api/v1/containers`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(config),
        },
        60000, // 60 seconds for container creation
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed (${response.status}): ${error}`);
      }

      return await response.json();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown API error";
      logger.error("Failed to create container:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
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
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed (${response.status}): ${error}`);
      }

      return await response.json();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown API error";
      logger.error("Failed to get container status:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * List all containers
   */
  async listContainers(): Promise<CloudApiResponse<ContainerData[]>> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.apiUrl}/api/v1/containers`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed (${response.status}): ${error}`);
      }

      return await response.json();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown API error";
      logger.error("Failed to list containers:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
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
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed (${response.status}): ${error}`);
      }

      return await response.json();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown API error";
      logger.error("Failed to delete container:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Poll container status until it reaches a terminal state
   */
  async waitForDeployment(
    containerId: string,
    options: {
      maxAttempts?: number;
      intervalMs?: number;
    } = {},
  ): Promise<CloudApiResponse<ContainerData>> {
    const maxAttempts = options.maxAttempts || 60; // 5 minutes with 5s intervals
    const intervalMs = options.intervalMs || 5000;

    for (let i = 0; i < maxAttempts; i++) {
      const response = await this.getContainer(containerId);

      if (!response.success) {
        return response;
      }

      const status = response.data?.status;

      // Terminal states
      if (status === "running") {
        return response;
      }

      if (status === "failed") {
        return {
          success: false,
          error: response.data?.error_message || "Deployment failed",
        };
      }

      // Log progress
      logger.info(`Deployment status: ${status}...`);

      // Wait before next check
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return {
      success: false,
      error: "Deployment timeout - container did not reach running state",
    };
  }

  /**
   * Upload artifact to R2 storage via Cloud API
   */
  async uploadArtifact(
    request: ArtifactUploadRequest & { artifactPath: string },
  ): Promise<CloudApiResponse<ArtifactUploadResponse>> {
    try {
      const fs = await import("node:fs");
      
      // First, request upload URL from API
      logger.info("📤 Requesting artifact upload URL...");
      
      const uploadRequest = await this.fetchWithTimeout(
        `${this.apiUrl}/api/v1/artifacts/upload`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            projectId: request.projectId,
            version: request.version,
            checksum: request.checksum,
            size: request.size,
            metadata: request.metadata,
          }),
        },
      );

      if (!uploadRequest.ok) {
        const error = await uploadRequest.text();
        throw new Error(`Failed to get upload URL (${uploadRequest.status}): ${error}`);
      }

      const uploadData = await uploadRequest.json() as CloudApiResponse<ArtifactUploadResponse>;
      
      if (!uploadData.success || !uploadData.data) {
        throw new Error(uploadData.error || "Failed to get upload URL");
      }

      // Validate response structure
      if (!uploadData.data.upload?.url) {
        throw new Error("Invalid response: missing upload URL");
      }

      // Now upload the artifact to the presigned URL
      logger.info("📤 Uploading artifact to storage...");
      
      const artifactBuffer = fs.readFileSync(request.artifactPath);
      const fileSizeMB = artifactBuffer.length / 1024 / 1024;
      
      // Use longer timeout for large files (1 minute per 10MB, minimum 2 minutes)
      const uploadTimeout = Math.max(120000, Math.ceil(fileSizeMB / 10) * 60000);
      
      const uploadResponse = await this.fetchWithTimeout(
        uploadData.data.upload.url,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/gzip",
          },
          body: artifactBuffer,
        },
        uploadTimeout,
      );

      if (!uploadResponse.ok) {
        throw new Error(`Failed to upload artifact (${uploadResponse.status}): ${uploadResponse.statusText}`);
      }

      logger.info("✅ Artifact uploaded successfully");

      return uploadData;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to upload artifact:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
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
  const apiKey =
    process.env.ELIZAOS_API_KEY || process.env.ELIZA_CLOUD_API_KEY;
  const apiUrl =
    process.env.ELIZAOS_API_URL ||
    process.env.ELIZA_CLOUD_API_URL ||
    "https://elizacloud.ai";

  if (!apiKey) {
    return null;
  }

  return { apiKey, apiUrl };
}


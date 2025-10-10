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
} from "../types";

export interface ApiClientOptions {
  apiKey: string;
  apiUrl: string;
}

export class CloudApiClient {
  private apiKey: string;
  private apiUrl: string;

  constructor(options: ApiClientOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl.replace(/\/$/, ""); // Remove trailing slash
  }

  /**
   * Get container quota and pricing information
   */
  async getQuota(): Promise<CloudApiResponse<QuotaInfo>> {
    try {
      const response = await fetch(`${this.apiUrl}/api/v1/containers/quota`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed: ${error}`);
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
   * Upload Docker image to Cloudflare via the cloud API
   */
  async uploadImage(
    imageName: string,
    imagePath: string,
  ): Promise<CloudApiResponse<{
    imageId: string;
    digest: string;
    size: number;
  }>> {
    try {
      const fs = await import("node:fs");
      const imageBuffer = fs.readFileSync(imagePath);

      logger.info(`📤 Uploading image to Cloudflare: ${imageName} (${(imageBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

      // Create abort controller for timeout (5 minutes for large uploads)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);

      try {
        const response = await fetch(
          `${this.apiUrl}/api/v1/containers/upload-image?name=${encodeURIComponent(imageName)}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/x-tar",
              "X-Image-Name": imageName,
            },
            body: imageBuffer,
            signal: controller.signal,
          },
        );

        clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Image upload failed: ${error}`);
      }

        const result = await response.json();
        logger.info(`✅ Image uploaded successfully: ${result.data.imageId}`);

        return result;
      } catch (fetchError: unknown) {
        clearTimeout(timeoutId);
        
        if (fetchError instanceof Error && fetchError.name === "AbortError") {
          throw new Error("Upload timeout after 5 minutes. Please check your network connection.");
        }
        throw fetchError;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown API error";
      logger.error("Failed to upload image:", errorMessage);
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
      const response = await fetch(`${this.apiUrl}/api/v1/containers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed: ${error}`);
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
      const response = await fetch(
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
        throw new Error(`API request failed: ${error}`);
      }

      return await response.json();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown API error";
      logger.error("Failed to get container:", errorMessage);
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
      const response = await fetch(`${this.apiUrl}/api/v1/containers`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed: ${error}`);
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
      const response = await fetch(
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
        throw new Error(`API request failed: ${error}`);
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


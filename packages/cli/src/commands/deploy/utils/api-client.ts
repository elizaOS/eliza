/**
 * ElizaOS Cloud API Client
 * Handles communication with the ElizaOS Cloud backend for deployments
 */

import { logger } from "@elizaos/core";
import type { ContainerConfig, CloudApiResponse } from "../types";

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
   * Create a new container deployment
   */
  async createContainer(
    config: ContainerConfig,
  ): Promise<CloudApiResponse<any>> {
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
  async getContainer(containerId: string): Promise<CloudApiResponse<any>> {
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
  async listContainers(): Promise<CloudApiResponse<any[]>> {
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
  ): Promise<CloudApiResponse<any>> {
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
    "https://eliza.cloud";

  if (!apiKey) {
    return null;
  }

  return { apiKey, apiUrl };
}


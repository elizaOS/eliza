/**
 * Neon Management API Client
 *
 * Handles all interactions with the Neon serverless Postgres platform.
 * Follows singleton pattern consistent with other services.
 *
 * @see https://api-docs.neon.tech/reference/getting-started
 */

import { logger } from "../utils/logger";

const NEON_API_BASE = "https://console.neon.tech/api/v2";
const NEON_API_KEY = process.env.NEON_API_KEY;

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const RETRY_BACKOFF_MULTIPLIER = 2;

/**
 * Neon API error response structure.
 */
export interface NeonApiError {
  code: string;
  message: string;
}

export class NeonClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "NeonClientError";
  }
}

export class NeonClient {
  private apiKey: string;

  constructor() {
    if (!NEON_API_KEY) {
      throw new Error("NEON_API_KEY environment variable is required");
    }
    this.apiKey = NEON_API_KEY;
  }

  /**
   * Delete a branch from a Neon project.
   *
   * @param projectId Parent project ID
   * @param branchId Branch ID to delete
   * @throws NeonClientError on API failure
   */
  async deleteBranch(projectId: string, branchId: string): Promise<void> {
    logger.info("Deleting Neon branch", { projectId, branchId });

    await this.fetchWithRetry(`/projects/${projectId}/branches/${branchId}`, {
      method: "DELETE",
    });

    logger.info("Neon branch deleted", { projectId, branchId });
  }

  /**
   * Delete a Neon project and all its data.
   *
   * @param projectId Neon project ID
   * @throws NeonClientError on API failure
   */
  async deleteProject(projectId: string): Promise<void> {
    logger.info("Deleting Neon project", { projectId });

    await this.fetchWithRetry(`/projects/${projectId}`, {
      method: "DELETE",
    });

    logger.info("Neon project deleted", { projectId });
  }

  /**
   * Get connection URI for an existing project.
   *
   * @param projectId Neon project ID
   * @returns Connection URI
   */
  async getConnectionUri(projectId: string): Promise<string> {
    const response = await this.fetchWithRetry(`/projects/${projectId}/connection_uri`, {
      method: "GET",
    });

    const data = (await response.json()) as { uri: string };
    return data.uri;
  }

  /**
   * Check if the API is accessible and credentials are valid.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.fetchWithRetry("/projects?limit=1", { method: "GET" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch with exponential backoff retry logic.
   */
  private async fetchWithRetry(
    endpoint: string,
    options: RequestInit,
    retryCount = 0,
  ): Promise<Response> {
    const url = `${NEON_API_BASE}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...headers, ...options.headers },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `Neon API error: ${response.status}`;
        let errorCode = "API_ERROR";

        try {
          const parsed = JSON.parse(errorBody);
          errorMessage = parsed.message || errorMessage;
          errorCode = parsed.code || errorCode;
        } catch {
          // Use default error message
        }

        // Retry on rate limit or server errors
        if ((response.status === 429 || response.status >= 500) && retryCount < MAX_RETRIES) {
          const delay = INITIAL_RETRY_DELAY_MS * RETRY_BACKOFF_MULTIPLIER ** retryCount;

          logger.warn("Neon API request failed, retrying", {
            status: response.status,
            retryCount,
            delayMs: delay,
          });

          await new Promise((resolve) => setTimeout(resolve, delay));
          return this.fetchWithRetry(endpoint, options, retryCount + 1);
        }

        throw new NeonClientError(errorMessage, errorCode, response.status);
      }

      return response;
    } catch (error) {
      if (error instanceof NeonClientError) {
        throw error;
      }

      // Network error - retry
      if (retryCount < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY_MS * RETRY_BACKOFF_MULTIPLIER ** retryCount;

        logger.warn("Neon API network error, retrying", {
          error: error instanceof Error ? error.message : "Unknown",
          retryCount,
          delayMs: delay,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.fetchWithRetry(endpoint, options, retryCount + 1);
      }

      throw new NeonClientError(
        `Network error: ${error instanceof Error ? error.message : "Unknown"}`,
        "NETWORK_ERROR",
      );
    }
  }
}

// Lazy singleton - only instantiate when NEON_API_KEY is available
let _neonClient: NeonClient | null = null;

/**
 * Gets the singleton NeonClient instance.
 * Throws if NEON_API_KEY environment variable is not set.
 *
 * Always use this function instead of creating NeonClient directly.
 */
export function getNeonClient(): NeonClient {
  if (!_neonClient) {
    _neonClient = new NeonClient();
  }
  return _neonClient;
}

/**
 * Neon Management API Client
 *
 * Handles all interactions with the Neon serverless Postgres platform.
 * Follows singleton pattern consistent with other services.
 *
 * @see https://api-docs.neon.tech/reference/getting-started
 */

import { logger } from "@/lib/utils/logger";

const NEON_API_BASE = "https://console.neon.tech/api/v2";
const NEON_API_KEY = process.env.NEON_API_KEY;

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const RETRY_BACKOFF_MULTIPLIER = 2;

/**
 * Result from creating a new Neon project.
 */
export interface NeonProjectResult {
  /** Neon project ID (e.g., "proj_xxxxxxxxxxxx") */
  projectId: string;

  /** Primary branch ID (e.g., "br_xxxxxxxxxxxx") */
  branchId: string;

  /** Full connection URI with credentials */
  connectionUri: string;

  /** Database host (e.g., "ep-xxx.us-east-1.aws.neon.tech") */
  host: string;

  /** Database name (default: "neondb") */
  database: string;

  /** AWS region (e.g., "aws-us-east-1") */
  region: string;
}

/**
 * Configuration for creating a Neon project.
 */
export interface NeonProjectConfig {
  /** Project name (used for identification) */
  name: string;

  /** AWS region ID (default: "aws-us-east-1") */
  region?: string;

  /** PostgreSQL version (default: 16) */
  pgVersion?: 14 | 15 | 16;
}

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
   * Create a new Neon project with a database.
   *
   * @param config Project configuration
   * @returns Project details including connection URI
   * @throws NeonClientError on API failure
   */
  async createProject(config: NeonProjectConfig): Promise<NeonProjectResult> {
    const { name, region = "aws-us-east-1", pgVersion = 16 } = config;

    logger.info("Creating Neon project", { name, region });

    const response = await this.fetchWithRetry("/projects", {
      method: "POST",
      body: JSON.stringify({
        project: {
          name,
          region_id: region,
          pg_version: pgVersion,
        },
      }),
    });

    const data = (await response.json()) as {
      project: { id: string };
      branch: { id: string };
      connection_uris?: Array<{ connection_uri: string }>;
    };

    // Extract connection details from response
    const project = data.project;
    const branch = data.branch;
    const connectionUri = data.connection_uris?.[0]?.connection_uri;

    if (!connectionUri) {
      throw new NeonClientError("No connection URI in Neon response", "MISSING_CONNECTION_URI");
    }

    // Extract host from connection URI safely
    let host: string;
    try {
      // Connection URI format: postgres://user:pass@host/db?params
      const uriWithoutProtocol = connectionUri.replace("postgres://", "");
      const afterAt = uriWithoutProtocol.split("@")[1];
      host = afterAt.split("/")[0];
    } catch {
      host = "unknown";
    }

    const result: NeonProjectResult = {
      projectId: project.id,
      branchId: branch.id,
      connectionUri,
      host,
      database: "neondb",
      region,
    };

    logger.info("Neon project created", {
      projectId: result.projectId,
      host: result.host,
    });

    return result;
  }

  /**
   * Create a new branch within an existing Neon project.
   * Each branch is an isolated copy-on-write fork with its own connection URI.
   *
   * @param projectId Parent project ID to branch from
   * @param branchName Human-readable branch name
   * @returns Branch details including connection URI
   * @throws NeonClientError on API failure
   */
  async createBranch(projectId: string, branchName: string): Promise<NeonProjectResult> {
    logger.info("Creating Neon branch", { projectId, branchName });

    const response = await this.fetchWithRetry(`/projects/${projectId}/branches`, {
      method: "POST",
      body: JSON.stringify({
        branch: { name: branchName },
        endpoints: [{ type: "read_write" }],
      }),
    });

    const data = (await response.json()) as {
      branch: { id: string };
      connection_uris?: Array<{ connection_uri: string }>;
    };
    const branch = data.branch;
    const connectionUri = data.connection_uris?.[0]?.connection_uri;

    if (!connectionUri) {
      throw new NeonClientError(
        "No connection URI in Neon branch response",
        "MISSING_CONNECTION_URI",
      );
    }

    let host: string;
    try {
      const uriWithoutProtocol = connectionUri.replace("postgres://", "");
      const afterAt = uriWithoutProtocol.split("@")[1];
      host = afterAt.split("/")[0];
    } catch {
      host = "unknown";
    }

    const result: NeonProjectResult = {
      projectId,
      branchId: branch.id,
      connectionUri,
      host,
      database: "neondb",
      region: "aws-us-east-1",
    };

    logger.info("Neon branch created", {
      projectId,
      branchId: result.branchId,
      host: result.host,
    });

    return result;
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

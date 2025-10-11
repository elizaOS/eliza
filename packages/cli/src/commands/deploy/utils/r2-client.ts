/**
 * R2 Client utilities for ElizaOS deployment
 * Handles artifact storage and retrieval from Cloudflare R2
 * 
 * Note: Currently the artifact upload is handled via the Cloud API
 * which manages R2 operations server-side. This client is kept for
 * potential future direct R2 operations or self-hosted deployments.
 */

import * as fs from "node:fs";
import { logger } from "@elizaos/core";
import fetch from "node-fetch";

export interface R2Config {
  accountId?: string;
  bucketName?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  apiToken?: string;
  customDomain?: string;
}

export interface R2UploadOptions {
  key: string;
  filePath: string;
  metadata?: Record<string, string>;
  contentType?: string;
  expiresIn?: number; // Seconds for presigned URL
}

export interface R2UploadResult {
  success: boolean;
  url?: string;
  key?: string;
  size?: number;
  etag?: string;
  error?: string;
}

export interface R2TokenOptions {
  bucketName: string;
  prefix?: string;
  permissions?: string[];
  expiresIn?: number; // Seconds
}

export interface R2TokenResult {
  success: boolean;
  token?: string;
  expiresAt?: string;
  error?: string;
}

export interface R2ListOptions {
  prefix?: string;
  maxKeys?: number;
  continuationToken?: string;
}

export interface R2Object {
  key: string;
  size: number;
  lastModified: Date;
  etag: string;
  metadata?: Record<string, string>;
}

/**
 * R2 Client for interacting with Cloudflare R2 storage
 */
export class R2Client {
  private config: R2Config;
  private baseUrl: string;

  constructor(config: R2Config) {
    this.config = config;

    // Construct base URL for R2 API
    if (config.customDomain) {
      this.baseUrl = `https://${config.customDomain}`;
    } else if (config.accountId && config.bucketName) {
      this.baseUrl = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucketName}`;
    } else {
      throw new Error("R2 configuration requires either customDomain or accountId + bucketName");
    }
  }

  /**
   * Upload a file to R2
   */
  async upload(options: R2UploadOptions): Promise<R2UploadResult> {
    try {
      const fileStats = fs.statSync(options.filePath);
      const fileStream = fs.createReadStream(options.filePath);

      // Construct URL
      const url = `${this.baseUrl}/${options.key}`;

      // Prepare headers
      const headers: Record<string, string> = {
        "Content-Type": options.contentType || "application/octet-stream",
        "Content-Length": fileStats.size.toString(),
      };

      // Add authentication
      if (this.config.apiToken) {
        headers["Authorization"] = `Bearer ${this.config.apiToken}`;
      } else if (this.config.accessKeyId && this.config.secretAccessKey) {
        // Use AWS Signature V4 for S3-compatible API
        // This would require additional implementation
        logger.warn("AWS Signature V4 authentication not yet implemented");
      }

      // Add metadata as x-amz-meta-* headers
      if (options.metadata) {
        for (const [key, value] of Object.entries(options.metadata)) {
          headers[`x-amz-meta-${key}`] = value;
        }
      }

      // Upload file
      const response = await fetch(url, {
        method: "PUT",
        headers,
        body: fileStream as any,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`R2 upload failed: ${response.status} ${errorText}`);
      }

      const etag = response.headers.get("etag") || undefined;

      logger.info(`✅ Uploaded to R2: ${options.key} (${(fileStats.size / 1024 / 1024).toFixed(2)} MB)`);

      return {
        success: true,
        url,
        key: options.key,
        size: fileStats.size,
        etag,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error("R2 upload failed:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Generate a presigned URL for downloading
   */
  async generatePresignedUrl(
    key: string,
    expiresIn = 3600,
  ): Promise<string> {
    // For public buckets with custom domain, the URL is simply the path
    if (this.config.customDomain) {
      return `${this.baseUrl}/${key}`;
    }

    // For private buckets, we need to generate a presigned URL
    // This would typically be done server-side via the Cloud API
    // Note: Actual implementation would require signing with secret key
    // This is a placeholder that should be replaced with actual signing logic
    const url = `${this.baseUrl}/${key}?X-Amz-Expires=${expiresIn}&X-Amz-Date=${new Date().toISOString()}`;

    return url;
  }

  /**
   * Generate a one-time scoped token for R2 access
   * This should be done via Cloudflare API
   */
  async generateScopedToken(options: R2TokenOptions): Promise<R2TokenResult> {
    try {
      if (!this.config.apiToken) {
        return {
          success: false,
          error: "API token required for generating scoped tokens",
        };
      }

      // Call Cloudflare API to create a temporary token
      // This is the actual Cloudflare API endpoint for creating API tokens
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/user/tokens`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `eliza-deploy-${Date.now()}`,
            policies: [
              {
                effect: "allow",
                resources: {
                  "com.cloudflare.api.account.*": "*",
                  "com.cloudflare.edge.r2.bucket.*": {
                    [options.bucketName]: options.prefix ? `${options.prefix}*` : "*",
                  },
                },
                permission_groups: [
                  {
                    id: "r2:read", // R2 read permission
                  },
                ],
              },
            ],
            not_before: new Date().toISOString(),
            expires_on: new Date(
              Date.now() + (options.expiresIn || 3600) * 1000,
            ).toISOString(),
          }),
        },
      );

      if (!response.ok) {
        const errorData = await response.json() as any;
        throw new Error(`Failed to create token: ${errorData.errors?.[0]?.message || response.statusText}`);
      }

      const data = await response.json() as any;

      return {
        success: true,
        token: data.result.value,
        expiresAt: data.result.expires_on,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to generate scoped token:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * List objects in R2 bucket
   */
  async list(options: R2ListOptions = {}): Promise<R2Object[]> {
    try {
      const params = new URLSearchParams();
      if (options.prefix) params.append("prefix", options.prefix);
      if (options.maxKeys) params.append("max-keys", options.maxKeys.toString());
      if (options.continuationToken) params.append("continuation-token", options.continuationToken);

      const url = `${this.baseUrl}?${params.toString()}`;

      const headers: Record<string, string> = {};
      if (this.config.apiToken) {
        headers["Authorization"] = `Bearer ${this.config.apiToken}`;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        throw new Error(`Failed to list R2 objects: ${response.statusText}`);
      }

      // Parse XML response (R2 uses S3-compatible API)
      const text = await response.text();
      const objects = this.parseListResponse(text);

      return objects;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to list R2 objects:", errorMessage);
      return [];
    }
  }

  /**
   * Delete an object from R2
   */
  async delete(key: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/${key}`;

      const headers: Record<string, string> = {};
      if (this.config.apiToken) {
        headers["Authorization"] = `Bearer ${this.config.apiToken}`;
      }

      const response = await fetch(url, {
        method: "DELETE",
        headers,
      });

      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete R2 object: ${response.statusText}`);
      }

      logger.info(`✅ Deleted from R2: ${key}`);
      return true;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to delete R2 object:", errorMessage);
      return false;
    }
  }

  /**
   * Parse XML list response (simplified parser)
   */
  private parseListResponse(xml: string): R2Object[] {
    const objects: R2Object[] = [];

    // Simple regex-based XML parsing (for production, use a proper XML parser)
    const contentRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match;

    while ((match = contentRegex.exec(xml)) !== null) {
      const content = match[1];

      const key = this.extractXmlValue(content, "Key");
      const size = parseInt(this.extractXmlValue(content, "Size") || "0", 10);
      const lastModified = new Date(
        this.extractXmlValue(content, "LastModified") || "",
      );
      const etag = this.extractXmlValue(content, "ETag")?.replace(/"/g, "") || "";

      if (key) {
        objects.push({
          key,
          size,
          lastModified,
          etag,
        });
      }
    }

    return objects;
  }

  /**
   * Extract value from XML string
   */
  private extractXmlValue(xml: string, tag: string): string | null {
    const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`);
    const match = xml.match(regex);
    return match ? match[1] : null;
  }
}

/**
 * Create R2 client from environment variables
 */
export function createR2ClientFromEnv(): R2Client | null {
  const config: R2Config = {
    accountId: process.env.R2_ACCOUNT_ID,
    bucketName: process.env.R2_BUCKET_NAME,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    customDomain: process.env.R2_CUSTOM_DOMAIN,
  };

  // Check if we have minimum required config
  if (!config.apiToken && (!config.accessKeyId || !config.secretAccessKey)) {
    logger.warn("R2 credentials not found in environment");
    return null;
  }

  if (!config.customDomain && (!config.accountId || !config.bucketName)) {
    logger.warn("R2 bucket configuration not found in environment");
    return null;
  }

  return new R2Client(config);
}

/**
 * Generate artifact key for R2 storage
 */
export function generateArtifactKey(
  organizationId: string,
  projectId: string,
  version: string,
): string {
  // Use a consistent key structure for easy management
  // Format: artifacts/{org-id}/{project-id}/{version}/artifact.tar.gz
  return `artifacts/${organizationId}/${projectId}/${version}/artifact.tar.gz`;
}

/**
 * Parse artifact key to extract components
 */
export function parseArtifactKey(key: string): {
  organizationId: string;
  projectId: string;
  version: string;
} | null {
  const match = key.match(/^artifacts\/([^/]+)\/([^/]+)\/([^/]+)\/artifact\.tar\.gz$/);
  
  if (!match) {
    return null;
  }

  return {
    organizationId: match[1],
    projectId: match[2],
    version: match[3],
  };
}

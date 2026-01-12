/**
 * Cloud Database Types
 */

/** Configuration for cloud database */
export interface CloudDatabaseConfig {
  apiKey: string;
  baseUrl: string;
  agentId: string;
}

/** Response from cloud database provisioning */
export interface DatabaseProvisionResponse {
  success: boolean;
  connectionUrl?: string;
  error?: string;
  expiresAt?: string;
}

/** Cloud database status */
export interface CloudDatabaseStatus {
  isProvisioned: boolean;
  isConnected: boolean;
  lastError?: string;
}

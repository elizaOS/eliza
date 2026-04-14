/**
 * Steward Sidecar types and constants.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StewardSidecarConfig {
  /** Directory for Steward data (PGLite storage, config, secrets). Default: ~/.eliza/steward/ */
  dataDir: string;
  /** Port for the local Steward API. Default: 3200 */
  port?: number;
  /** Master password for Steward's vault encryption. Auto-generated on first launch if not set. */
  masterPassword?: string;
  /** Path to the steward API entry point (bun script). */
  stewardEntryPoint?: string;
  /** DATABASE_URL override. When empty, sidecar will look for PGLite or use dataDir-based config. */
  databaseUrl?: string;
  /** Max restart attempts before giving up. Default: 5 */
  maxRestarts?: number;
  /** Callback for status changes (for UI indicators). */
  onStatusChange?: (status: StewardSidecarStatus) => void;
  /** Callback for log output from the child process. */
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
}

export interface StewardSidecarStatus {
  state: "stopped" | "starting" | "running" | "error" | "restarting";
  port: number | null;
  pid: number | null;
  error: string | null;
  restartCount: number;
  walletAddress: string | null;
  agentId: string | null;
  tenantId: string | null;
  startedAt: number | null;
}

export interface StewardWalletInfo {
  tenantId: string;
  tenantApiKey: string;
  agentId: string;
  agentName: string;
  agentToken: string;
  walletAddress: string;
}

export interface StewardCredentials {
  tenantId: string;
  tenantApiKey: string;
  agentId: string;
  agentToken: string;
  walletAddress: string;
  masterPassword?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PORT = 3200;
export const DEFAULT_MAX_RESTARTS = 5;
export const HEALTH_CHECK_INTERVAL_MS = 500;
export const HEALTH_CHECK_TIMEOUT_MS = 30_000;
export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;
export const DEFAULT_TENANT_ID = "elizaos-desktop";
export const DEFAULT_TENANT_NAME = "Desktop";
export const DEFAULT_AGENT_ID = "eliza-wallet";
export const DEFAULT_AGENT_NAME = "eliza-wallet";
export const CREDENTIALS_FILE = "credentials.json";

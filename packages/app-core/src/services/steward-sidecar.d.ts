/**
 * Steward Sidecar - manages Steward API as a child process for embedded wallet functionality.
 *
 * Responsibilities:
 *   - Start Steward API as a child process on a local port (default 3200)
 *   - Health check polling until Steward is ready
 *   - Auto-restart on crash (exponential backoff)
 *   - Clean shutdown on app exit
 *   - First-launch wallet creation (tenant + agent + wallet)
 *   - Subsequent launches: verify existing wallet loads
 *
 * The sidecar runs Steward in embedded mode with a local Postgres-compatible
 * database (PGLite when available, or standard Postgres via DATABASE_URL).
 *
 * Usage:
 *   const sidecar = new StewardSidecar({ dataDir: '~/.eliza/steward/' });
 *   await sidecar.start();  // starts process + first-launch setup
 *   const client = sidecar.getClient();
 *   await sidecar.stop();
 */
import {
  type StewardCredentials,
  type StewardSidecarConfig,
  type StewardSidecarStatus,
} from "./steward-sidecar/types";

export {
  allocateFirstFreeLoopbackPort,
  fingerprintRandomToken,
  generateApiKey,
  generateMasterPassword,
  resolveDataDir,
} from "./steward-sidecar/helpers";
export type {
  StewardCredentials,
  StewardSidecarConfig,
  StewardSidecarStatus,
  StewardWalletInfo,
} from "./steward-sidecar/types";
export declare class StewardSidecar {
  private config;
  private status;
  private process;
  private stopping;
  private restartTimer;
  private credentials;
  private healthCheckAbort;
  constructor(config: StewardSidecarConfig);
  /**
   * Start the Steward sidecar process and wait until it's healthy.
   * On first launch, creates tenant + agent + wallet.
   * On subsequent launches, verifies existing wallet.
   */
  start(): Promise<StewardSidecarStatus>;
  /** Stop the Steward sidecar process gracefully. */
  stop(): Promise<void>;
  /** Restart the sidecar (stop + start). */
  restart(): Promise<StewardSidecarStatus>;
  /** Get current sidecar status. */
  getStatus(): StewardSidecarStatus;
  /** Get the API base URL for Steward. */
  getApiBase(): string;
  /** Get stored wallet credentials (null if not initialized). */
  getCredentials(): StewardCredentials | null;
  /** Get tenant API key for making authenticated requests. */
  getTenantApiKey(): string | null;
  /** Get agent token for making agent-scoped requests. */
  getAgentToken(): string | null;
  private ensureDataDir;
  private loadOrCreateCredentials;
  private spawnProcess;
  private handleCrash;
  private updateStatus;
}
/**
 * Create a StewardSidecar with standard defaults.
 *
 * Uses environment variables for overrides:
 *   - STEWARD_DATA_DIR: data directory (default: ~/.eliza/steward/)
 *   - STEWARD_PORT: API port (default: 3200)
 *   - STEWARD_MASTER_PASSWORD: vault encryption password
 *   - STEWARD_ENTRY_POINT: path to steward API entry
 *   - DATABASE_URL: Postgres connection string
 */
export declare function createDesktopStewardSidecar(
  overrides?: Partial<StewardSidecarConfig>,
): StewardSidecar;
//# sourceMappingURL=steward-sidecar.d.ts.map

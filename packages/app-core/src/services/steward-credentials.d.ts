/**
 * Steward credential persistence for non-sidecar (web/dev) mode.
 *
 * On first setup, saves steward credentials to `<state-dir>/steward-credentials.json`.
 * State dir honors ELIZA_STATE_DIR > ~/.eliza.
 * Environment variables always override file values.
 */
export interface PersistedStewardCredentials {
  apiUrl: string;
  tenantId: string;
  agentId: string;
  apiKey: string;
  agentToken: string;
  walletAddresses?: {
    evm?: string;
    solana?: string;
  };
  agentName?: string;
  createdAt?: string;
}
/**
 * Load persisted steward credentials from disk.
 * Returns null if file doesn't exist or is unreadable.
 */
export declare function loadStewardCredentials(): PersistedStewardCredentials | null;
/**
 * Save steward credentials to disk with restrictive permissions (0o600).
 */
export declare function saveStewardCredentials(
  credentials: PersistedStewardCredentials,
): void;
/**
 * Resolve effective steward configuration by merging:
 *   env vars > persisted file > defaults
 *
 * Returns null if steward is not configured at all.
 */
export declare function resolveEffectiveStewardConfig(
  env?: NodeJS.ProcessEnv,
): PersistedStewardCredentials | null;
//# sourceMappingURL=steward-credentials.d.ts.map

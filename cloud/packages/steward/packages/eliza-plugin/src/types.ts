/**
 * Plugin-specific types for @stwd/eliza-plugin
 */

export interface StewardPluginConfig {
  apiUrl: string;
  apiKey?: string;
  agentId: string;
  tenantId?: string;
  autoRegister: boolean;
  fallbackLocal: boolean;
}

/** Parsed human-readable transfer amount */
export interface ParsedAmount {
  value: string;
  symbol: string;
  /** Amount in smallest unit (wei, lamports, etc.) */
  rawValue: string;
}

/** Chain detection result */
export type ChainType = "evm" | "solana";

/** Summary of a policy rule for display */
export interface PolicySummary {
  type: string;
  description: string;
  enabled: boolean;
}

/**
 * Module augmentation so runtime.getService("STEWARD") is type-safe.
 */
declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    STEWARD: "steward";
  }
}

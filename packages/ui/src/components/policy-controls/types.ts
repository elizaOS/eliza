export type PolicyType =
  | "spending-limit"
  | "approved-addresses"
  | "auto-approve-threshold"
  | "time-window"
  | "rate-limit";

export interface PolicyRule {
  id: string;
  type: PolicyType;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** All monetary amounts are USD strings for cross-chain compatibility. */
export interface SpendingLimitConfig {
  /** USD amount per transaction */
  maxPerTx: string;
  /** USD amount per day */
  maxPerDay: string;
  /** USD amount per week */
  maxPerWeek: string;
}

export interface ApprovedAddressEntry {
  address: string;
  label: string;
  /** Detected chain type based on address format */
  chainType?: "evm" | "solana";
}

export interface ApprovedAddressesConfig {
  addresses: Array<string | ApprovedAddressEntry>;
  labels?: Record<string, string>;
  mode: "whitelist" | "blacklist";
}

export interface RateLimitConfig {
  maxTxPerHour: number;
  maxTxPerDay: number;
}

export interface TimeWindowConfig {
  allowedHours: { start: number; end: number }[];
  allowedDays: number[];
  timezone?: string;
}

/** Threshold is a USD string for cross-chain compatibility. */
export interface AutoApproveConfig {
  /** USD amount */
  threshold: string;
}

/** Maps each policy type to its strongly-typed config shape. */
export interface PolicyConfigMap {
  "spending-limit": SpendingLimitConfig;
  "approved-addresses": ApprovedAddressesConfig;
  "auto-approve-threshold": AutoApproveConfig;
  "time-window": TimeWindowConfig;
  "rate-limit": RateLimitConfig;
}

/**
 * Extract a policy's config with the correct type for its `type` discriminant.
 * Falls back to `fallback` when the policy is missing.
 */
export function getPolicyConfig<T extends PolicyType>(
  policy: PolicyRule | undefined,
  fallback: PolicyConfigMap[T],
): PolicyConfigMap[T] {
  return policy?.config ? Object.assign({}, fallback, policy.config) : fallback;
}

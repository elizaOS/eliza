/**
 * Versioned, server-owned account billing snapshot transport contract.
 *
 * Every v2 datum is an explicit observation. Consumers must branch on
 * `status`; missing authorities and undecided policy are never encoded as
 * zero, false, or an absent property.
 */

export type ObservationStatus = "available" | "unavailable" | "unknown_policy" | "not_applicable";

interface ObservationProvenance {
  /** Stable server-side authority or adapter that produced this observation. */
  source: string;
  /** Timestamp for this source, which may differ from the primary snapshot. */
  observedAt: string;
}

export interface AvailableObservation<T> extends ObservationProvenance {
  status: "available";
  value: T;
}

export interface UnavailableObservation extends ObservationProvenance {
  status: "unavailable";
  error: {
    /** Stable machine-readable reason; never a raw provider/database error. */
    code: string;
    retryable: boolean;
  };
}

export interface UnknownPolicyObservation extends ObservationProvenance {
  status: "unknown_policy";
  /** Issue/decision identifiers that must be resolved before a value exists. */
  blockedBy: string[];
}

export interface NotApplicableObservation extends ObservationProvenance {
  status: "not_applicable";
  reason: string;
}

export type Observed<T> =
  | AvailableObservation<T>
  | UnavailableObservation
  | UnknownPolicyObservation
  | NotApplicableObservation;

export type ExactBillingUnit =
  | "count"
  | "byte"
  | "request_per_minute"
  | "usd"
  | "usd_per_hour"
  | "usd_per_day";

/** Exact base-10 value. It is deliberately never a JavaScript number. */
export interface ExactBillingValue {
  value: string;
  unit: ExactBillingUnit;
  currency?: "USD";
}

export interface LimitCountPolicy {
  included: string[];
  excluded: string[];
}

/**
 * Common quota shape. Every field is observed independently because one
 * authority can expose aggregate occupancy without reservation/deletion
 * decomposition (storage), or configuration without a live counter (DO RPM).
 */
export interface ObservedLimitSnapshot {
  used: Observed<ExactBillingValue>;
  reserved: Observed<ExactBillingValue>;
  deleting: Observed<ExactBillingValue>;
  limit: Observed<ExactBillingValue>;
  remaining: Observed<ExactBillingValue>;
  resetAt: Observed<string | null>;
  countsTowardLimit: Observed<LimitCountPolicy>;
}

export interface AccountBalanceSnapshot {
  balance: ExactBillingValue & { unit: "usd"; currency: "USD" };
  /** Exact bigint revision serialized as base-10 text. */
  revision: string;
}

export interface PaymentMethodPresenceSnapshot {
  /** Presence of the persisted `organizations.stripe_customer_id`; no provider lookup is implied. */
  customerIdPresent: boolean;
  /** Presence of the persisted `organizations.stripe_default_payment_method`. */
  defaultPaymentMethodIdPresent: boolean;
}

export type BillingReadinessBlockerCode =
  | "missing_customer_id"
  | "invalid_customer_id"
  | "missing_default_payment_method_id"
  | "invalid_default_payment_method_id"
  | "customer_binding_not_authoritative";

export interface BillingReadinessSnapshot {
  ready: boolean;
  blockers: BillingReadinessBlockerCode[];
}

export interface AutoTopUpConfigurationSnapshot {
  accountActive: boolean;
  enabled: boolean;
  threshold: (ExactBillingValue & { unit: "usd"; currency: "USD" }) | null;
  amount: (ExactBillingValue & { unit: "usd"; currency: "USD" }) | null;
}

export interface AutoTopUpControlSnapshot {
  mode: "paused" | "durable";
  pausedAt: string;
  legacyReconciledThrough: string | null;
}

export interface AutoTopUpBlockingSnapshot {
  durableAttempt: boolean;
  legacyQuarantine: boolean;
}

export interface AutoTopUpRearmSnapshot {
  balanceDecreaseRevision: string;
  coveredBalanceDecreaseRevision: string | null;
  rearmed: boolean;
}

export type AutoTopUpReadinessBlockerCode =
  | BillingReadinessBlockerCode
  | "inactive_organization"
  | "disabled_by_organization"
  | "missing_threshold"
  | "invalid_threshold"
  | "missing_amount"
  | "invalid_amount"
  | "balance_at_or_above_threshold"
  | "runtime_switch_disabled"
  | "cutover_paused"
  | "blocking_attempt"
  | "legacy_quarantine"
  | "balance_not_rearmed";

export interface AutoTopUpSnapshot {
  configuration: Observed<AutoTopUpConfigurationSnapshot>;
  runtimeSwitch: Observed<{ enabled: boolean }>;
  control: Observed<AutoTopUpControlSnapshot>;
  customerBinding: Observed<{ authoritative: boolean }>;
  blockingState: Observed<AutoTopUpBlockingSnapshot>;
  rearm: Observed<AutoTopUpRearmSnapshot>;
  readiness: Observed<{
    canStartNewAttempt: boolean;
    blockers: AutoTopUpReadinessBlockerCode[];
  }>;
}

export interface ConfiguredInferenceTierSnapshot {
  /** Legacy runtime selector key; values such as `paid` are not economic labels. */
  selectorKey: string;
  /**
   * Input observed by the current tier selector after its legacy metadata
   * exclusions. Economic qualification remains undecided by #23019.
   */
  tierSourceCreditTotalObserved: ExactBillingValue & { unit: "usd"; currency: "USD" };
  overrides: {
    completionsRpm: string | null;
    embeddingsRpm: string | null;
    standardRpm: string | null;
    strictRpm: string | null;
  };
  completionsRpm: string;
  embeddingsRpm: string;
  standardRpm: string;
  strictRpm: string;
}

export interface RuntimeInferenceTierSnapshot {
  /** Cache copy of the legacy runtime selector key, not a product label. */
  selectorKey: string;
  completionsRpm: string;
  embeddingsRpm: string;
  standardRpm: string;
  strictRpm: string;
}

export interface AccountTierSnapshot {
  configured: Observed<ConfiguredInferenceTierSnapshot>;
  /** Eligibility provenance is unresolved by #23019 even when current code resolves a tier. */
  eligibilityPolicy: Observed<never>;
  /** Cache-only runtime state; this observation never hydrates or mutates it. */
  runtimeCache: Observed<RuntimeInferenceTierSnapshot>;
}

export type ActiveComputeResourceType = "container" | "agent_sandbox";
export type ActiveComputeBillingInterval = "hour" | "day";

export interface ActiveComputeRateSegmentSnapshot {
  workloadKind: "agent" | "container";
  billingState: "running" | "backup";
  effectiveAt: string;
}

export interface ActiveComputeResourceSnapshot {
  resourceType: ActiveComputeResourceType;
  resourceId: string;
  name: string;
  status: string;
  billingStatus: string;
  billingInterval: ActiveComputeBillingInterval;
  lastBilledAt: string | null;
  nextBillingAt: string | null;
  estimatedNextBillingAt: string | null;
  rateSegment: Observed<ActiveComputeRateSegmentSnapshot>;
  ratePerHour: Observed<ExactBillingValue & { unit: "usd_per_hour"; currency: "USD" }>;
  estimatedRecurringComputeCostPerDay: Observed<
    ExactBillingValue & { unit: "usd_per_day"; currency: "USD" }
  >;
}

export interface ActiveComputeScopeSnapshot {
  organizationScoped: true;
  selectors: {
    containers: {
      lifecycleStatuses: string[];
      billingStatuses: string[];
    };
    agentSandboxes: {
      excludedExecutionTiers: string[];
      lifecyclePredicates: Array<{
        status: string;
        requiresLastBackup: boolean;
      }>;
      billingStatuses: string[];
    };
  };
  rateAuthority: {
    source: "compute_billing_rate_segments";
    selection: "latest_effective_at_or_before_primary_transaction";
  };
}

export interface ActiveComputeSnapshot {
  resources: Observed<ActiveComputeResourceSnapshot[]>;
  estimatedRecurringComputeCostPerDay: Observed<
    ExactBillingValue & { unit: "usd_per_day"; currency: "USD" }
  >;
  scope: Observed<ActiveComputeScopeSnapshot>;
}

export interface AccountBillingLimitsV2 {
  apiKeys: ObservedLimitSnapshot;
  cloudCharacters: ObservedLimitSnapshot;
  agentSandboxes: {
    nonEagerCreate: ObservedLimitSnapshot;
    eagerManagedCreate: ObservedLimitSnapshot;
  };
  containers: ObservedLimitSnapshot;
  apps: ObservedLimitSnapshot;
  storage: ObservedLimitSnapshot;
  inference: {
    completions: ObservedLimitSnapshot;
    embeddings: ObservedLimitSnapshot;
    /** Undecided weekly contract; every datum stays explicit until #22962 resolves it. */
    weekly: ObservedLimitSnapshot;
  };
}

export interface AccountBillingSnapshotV2 {
  snapshotStartedAt: string;
  snapshotCompletedAt: string;
  balance: Observed<AccountBalanceSnapshot>;
  paymentMethodPresence: Observed<PaymentMethodPresenceSnapshot>;
  billingReadiness: Observed<BillingReadinessSnapshot>;
  autoTopUp: AutoTopUpSnapshot;
  tier: AccountTierSnapshot;
  limits: AccountBillingLimitsV2;
  activeCompute: ActiveComputeSnapshot;
}

// ---------------------------------------------------------------------------
// Temporary v1 compatibility projection.
// ---------------------------------------------------------------------------

export type LimitItemState = "available" | "at-limit" | "over-limit" | "unavailable";

export interface CountedLimitItem {
  source: string;
  state: LimitItemState;
  used?: number;
  limit?: number;
  reason?: string;
}

export interface SandboxCreateLimitItem {
  state: LimitItemState;
  limit?: number;
  reason?: string;
}

export interface SandboxLimitItem {
  source: string;
  used?: number;
  nonEagerCreate: SandboxCreateLimitItem;
  eagerManagedCreate: SandboxCreateLimitItem;
  state: LimitItemState;
  nonEagerCreateLimit?: number;
  eagerManagedCreateLimit?: number;
  reason?: string;
}

export interface StorageLimitItem {
  source: string;
  state: LimitItemState;
  bytesUsed?: string;
  bytesLimit?: string;
  reason?: string;
}

export interface InferenceRateLimitItem {
  source: string;
  state: LimitItemState;
  completionsRpm?: number;
  embeddingsRpm?: number;
  reason?: string;
}

export interface AccountLimitsSnapshotV1 {
  observedAt: string;
  cloudCharacters: CountedLimitItem;
  agentSandboxes: SandboxLimitItem;
  containers: CountedLimitItem;
  apps: CountedLimitItem;
  storage: StorageLimitItem;
  inferenceRateLimits: InferenceRateLimitItem;
}

/** Additive route response: the seven v1 fields remain top-level. */
export interface AccountBillingSnapshot extends AccountLimitsSnapshotV1 {
  schemaVersion: 2;
  v2: AccountBillingSnapshotV2;
}

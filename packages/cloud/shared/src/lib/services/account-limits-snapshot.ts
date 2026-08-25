/**
 * Assembles the read-only, organization-scoped billing and quota contract
 * consumed by Cloud account surfaces. The v2 snapshot preserves exact decimal
 * values, primary-transaction coherence, per-datum availability, and the
 * canonical create-time counting predicates; the top-level v1 fields are a
 * temporary compatibility projection of those same observations.
 *
 * Undecided policy is explicit, and missing rate or quota authorities never
 * become plausible prices, entitlements, or zero usage.
 */

import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm";
import type {
  PrimaryAccountBillingReadModel,
  PrimaryComputeRateSegment,
} from "../../db/repositories/account-billing-snapshot";
import type {
  AccountBillingSnapshot,
  AccountBillingSnapshotV2,
  AccountLimitsSnapshotV1 as AccountLimitsSnapshot,
  ActiveComputeRateSegmentSnapshot,
  ActiveComputeResourceSnapshot,
  AutoTopUpReadinessBlockerCode,
  BillingReadinessBlockerCode,
  CountedLimitItem,
  ExactBillingUnit,
  ExactBillingValue,
  InferenceRateLimitItem,
  LimitCountPolicy,
  LimitItemState,
  Observed,
  ObservedLimitSnapshot,
  SandboxCreateLimitItem,
  SandboxLimitItem,
  StorageLimitItem,
} from "../../types/account-billing-snapshot";

export type {
  AccountBillingSnapshot,
  AccountBillingSnapshotV2,
  AccountLimitsSnapshotV1,
  AccountLimitsSnapshotV1 as AccountLimitsSnapshot,
  CountedLimitItem,
  InferenceRateLimitItem,
  LimitItemState,
  SandboxCreateLimitItem,
  SandboxLimitItem,
  StorageLimitItem,
} from "../../types/account-billing-snapshot";

/**
 * Injected readers. Each maps 1:1 onto the enforcement source it mirrors; the
 * route wires the real services, and tests can fail any single source to
 * prove isolation.
 */
export interface AccountLimitsSources {
  /** Org billing row: credit balance and settings (for ceiling overrides). */
  orgBilling(): Promise<{
    creditBalance: number;
    settings?: unknown;
  }>;
  /** Count of Cloud characters (`user_characters` with source=cloud). */
  cloudCharacterCount(): Promise<number>;
  /** Count of quota-holding (counted-status, non-pool) agent sandboxes. */
  sandboxQuotaCount(): Promise<number>;
  /** Container quota check — the same repository call the create path uses. */
  containerQuota(): Promise<{
    current: number;
    max: number;
    sourceUnavailable?: boolean;
  }>;
  /** Count of apps for the org. */
  appCount(): Promise<number>;
  /** Configured per-org app ceiling. */
  appLimit(): Promise<number>;
  /** `org_storage_quota` row, or null when the org has no row yet. */
  storageQuota(): Promise<{ bytesUsed: bigint; bytesLimit: bigint } | null>;
  /** Org inference tier (tier + overrides already merged). */
  inferenceRateTier(): Promise<{
    completionsRpm: number;
    embeddingsRpm: number;
  }>;
  /** Canonical Cloud-character ceiling helper (create-time enforcement). */
  maxCloudCharacters(creditBalance: number, settings?: unknown): number;
  /** Canonical sandbox ceiling helper (create-time enforcement). */
  maxNonTerminalAgents(creditBalance: number | undefined): number;
  /** Schema default applied when the org has no storage-quota row. */
  defaultStorageBytesLimit: bigint;
}

function classify(used: number, limit: number): LimitItemState {
  if (used > limit) return "over-limit";
  if (used >= limit) return "at-limit";
  return "available";
}

function isUsableCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUsableLimit(value: unknown): value is number {
  return isUsableCount(value) && value > 0;
}

const EXPECTED_SOURCE_ERROR_CODES = new Set([
  "ACCOUNT_LIMIT_SOURCE_UNAVAILABLE",
  "INVALID_ACCOUNT_LIMIT_SOURCE",
  "INVALID_AGENT_SANDBOX_QUOTA_SOURCE",
  "INVALID_CLOUD_CHARACTER_QUOTA_SOURCE",
  "INVALID_CONTAINER_QUOTA_SOURCE",
  "INVALID_MAX_APPS_PER_ORG",
  "MISSING_CONTAINER_QUOTA_SOURCE",
  "ORG_RATE_LIMIT_SOURCE_INVALID",
]);

function unavailableReason(error: unknown): string {
  const expected =
    error instanceof DrizzleError ||
    error instanceof DrizzleQueryError ||
    (error instanceof ElizaError && EXPECTED_SOURCE_ERROR_CODES.has(error.code));
  if (!expected) throw error;

  return error instanceof ElizaError && error.code === "INVALID_ACCOUNT_LIMIT_SOURCE"
    ? error.message
    : "source read failed";
}

function invalidSourceData(message: string): ElizaError {
  return new ElizaError(message, {
    code: "INVALID_ACCOUNT_LIMIT_SOURCE",
    severity: "fatal",
  });
}

/**
 * Builds the snapshot. Sections fail independently: one unreadable source
 * yields one `unavailable` item and never poisons its siblings, and the org
 * billing row failing marks only the balance-derived ceilings unavailable.
 */
export async function buildAccountLimitsSnapshot(
  sources: AccountLimitsSources,
): Promise<AccountLimitsSnapshot> {
  const observedAt = new Date().toISOString();

  let billing: { creditBalance: number; settings?: unknown } | { error: unknown };
  try {
    const row = await sources.orgBilling();
    if (!Number.isFinite(Number(row.creditBalance))) {
      throw invalidSourceData("organization credit balance is not a finite number");
    }
    billing = row;
  } catch (error) {
    // error-policy:J4 — the org row failing must surface as unavailable
    // ceilings, never as a free-tier default; unexpected defects escape here.
    unavailableReason(error);
    billing = { error };
  }

  const cloudCharacters: CountedLimitItem = await (async () => {
    const source = "cloud-character-quota";
    try {
      const used = await sources.cloudCharacterCount();
      if (!isUsableCount(used)) {
        throw invalidSourceData("cloud character count is not a usable non-negative integer");
      }
      if ("error" in billing) {
        return {
          source,
          state: "unavailable" as const,
          reason: unavailableReason(billing.error),
        };
      }
      const limit = sources.maxCloudCharacters(billing.creditBalance, billing.settings);
      if (!isUsableLimit(limit)) {
        throw invalidSourceData("cloud character limit is not a usable positive integer");
      }
      return { source, state: classify(used, limit), used, limit };
    } catch (error) {
      // error-policy:J4 — unreadable usage is reported, not zeroed.
      return {
        source,
        state: "unavailable" as const,
        reason: unavailableReason(error),
      };
    }
  })();

  const agentSandboxes: SandboxLimitItem = await (async () => {
    const source = "agent-sandbox-quota";
    let used: number;
    try {
      used = await sources.sandboxQuotaCount();
      if (!isUsableCount(used)) {
        throw invalidSourceData("sandbox quota count is not a usable non-negative integer");
      }
    } catch (error) {
      // error-policy:J4 — an expected count-source failure makes both create
      // views explicitly unavailable; programming defects still escape.
      const reason = unavailableReason(error);
      return {
        source,
        state: "unavailable",
        reason,
        nonEagerCreate: { state: "unavailable", reason },
        eagerManagedCreate: { state: "unavailable", reason },
      };
    }

    const nonEagerCreate: SandboxCreateLimitItem = (() => {
      try {
        const limit = sources.maxNonTerminalAgents(undefined);
        if (!isUsableLimit(limit)) {
          throw invalidSourceData("non-eager sandbox limit is not a usable positive integer");
        }
        return { state: classify(used, limit), limit };
      } catch (error) {
        // error-policy:J4 — only a typed invalid fixed-cap source degrades this
        // path; an unrelated implementation defect is rethrown.
        return { state: "unavailable", reason: unavailableReason(error) };
      }
    })();

    const eagerManagedCreate: SandboxCreateLimitItem = (() => {
      if ("error" in billing) {
        return { state: "unavailable", reason: unavailableReason(billing.error) };
      }
      try {
        const limit = sources.maxNonTerminalAgents(billing.creditBalance);
        if (!isUsableLimit(limit)) {
          throw invalidSourceData("eager sandbox limit is not a usable positive integer");
        }
        return { state: classify(used, limit), limit };
      } catch (error) {
        // error-policy:J4 — a typed balance/cap source failure degrades only the
        // eager path; the fixed non-eager result remains truthful.
        return { state: "unavailable", reason: unavailableReason(error) };
      }
    })();

    return {
      source,
      used,
      nonEagerCreate,
      eagerManagedCreate,
      // Compatibility aliases preserve #19949's eager-state semantics while
      // new consumers migrate to the two unambiguous per-path results above.
      state: eagerManagedCreate.state,
      ...(nonEagerCreate.limit === undefined ? {} : { nonEagerCreateLimit: nonEagerCreate.limit }),
      ...(eagerManagedCreate.limit === undefined
        ? {}
        : { eagerManagedCreateLimit: eagerManagedCreate.limit }),
      ...(eagerManagedCreate.reason === undefined ? {} : { reason: eagerManagedCreate.reason }),
    };
  })();

  const containers: CountedLimitItem = await (async () => {
    const source = "container-quota";
    try {
      const quota = await sources.containerQuota();
      if (quota.sourceUnavailable) {
        throw invalidSourceData("container quota source is unavailable");
      }
      if (!isUsableCount(quota.current) || !isUsableLimit(quota.max)) {
        throw invalidSourceData("container quota returned invalid counts");
      }
      return {
        source,
        state: classify(quota.current, quota.max),
        used: quota.current,
        limit: quota.max,
      };
    } catch (error) {
      // error-policy:J4 — expected container source/read failures are an
      // explicit unavailable item; programming defects still escape.
      return {
        source,
        state: "unavailable" as const,
        reason: unavailableReason(error),
      };
    }
  })();

  const apps: CountedLimitItem = await (async () => {
    const source = "apps-service";
    try {
      const [used, limit] = await Promise.all([sources.appCount(), sources.appLimit()]);
      if (!isUsableCount(used) || !isUsableLimit(limit)) {
        throw invalidSourceData("app count or limit is not a usable positive integer");
      }
      return { source, state: classify(used, limit), used, limit };
    } catch (error) {
      // error-policy:J4 — expected app count/config failures are an explicit
      // unavailable item; programming defects still escape.
      return {
        source,
        state: "unavailable" as const,
        reason: unavailableReason(error),
      };
    }
  })();

  const storage: StorageLimitItem = await (async () => {
    const source = "org-storage-quota";
    try {
      const row = await sources.storageQuota();
      if (row === null) {
        // No row yet: the schema's explicit default ceiling with zero usage —
        // the only case where an absent source maps to a value, because the
        // write path creates the row lazily with exactly these semantics.
        if (sources.defaultStorageBytesLimit < 0n) {
          throw invalidSourceData("default storage limit is negative");
        }
        return {
          source,
          state: "available" as const,
          bytesUsed: "0",
          bytesLimit: sources.defaultStorageBytesLimit.toString(),
        };
      }
      if (typeof row.bytesUsed !== "bigint" || typeof row.bytesLimit !== "bigint") {
        throw invalidSourceData("storage quota row returned non-bigint bytes");
      }
      if (row.bytesUsed < 0n || row.bytesLimit < 0n) {
        throw invalidSourceData("storage quota row returned negative bytes");
      }
      const state: LimitItemState =
        row.bytesUsed > row.bytesLimit
          ? "over-limit"
          : row.bytesUsed >= row.bytesLimit
            ? "at-limit"
            : "available";
      return {
        source,
        state,
        bytesUsed: row.bytesUsed.toString(),
        bytesLimit: row.bytesLimit.toString(),
      };
    } catch (error) {
      // error-policy:J4 — expected storage read/validation failures are an
      // explicit unavailable item; programming defects still escape.
      return {
        source,
        state: "unavailable" as const,
        reason: unavailableReason(error),
      };
    }
  })();

  const inferenceRateLimits: InferenceRateLimitItem = await (async () => {
    const source = "org-rate-limits";
    try {
      const tier = await sources.inferenceRateTier();
      if (!isUsableLimit(tier.completionsRpm) || !isUsableLimit(tier.embeddingsRpm)) {
        throw invalidSourceData("org rate tier returned invalid caps");
      }
      // Configured caps only: no current usage, remaining requests, or
      // route-protection presets — this snapshot does not claim enforcement
      // observations it does not have.
      return {
        source,
        state: "available" as const,
        completionsRpm: tier.completionsRpm,
        embeddingsRpm: tier.embeddingsRpm,
      };
    } catch (error) {
      // error-policy:J4 — expected tier source/validation failures are an
      // explicit unavailable item; programming defects still escape.
      return {
        source,
        state: "unavailable" as const,
        reason: unavailableReason(error),
      };
    }
  })();

  return {
    observedAt,
    cloudCharacters,
    agentSandboxes,
    containers,
    apps,
    storage,
    inferenceRateLimits,
  };
}

// ---------------------------------------------------------------------------
// Canonical additive v2 snapshot (#22954).
// ---------------------------------------------------------------------------

export type RuntimeTierCacheObservation =
  | {
      kind: "ready";
      tier: {
        tierName: string;
        completionsRpm: number;
        embeddingsRpm: number;
        standardRpm: number;
        strictRpm: number;
      };
    }
  | {
      kind: "warming" | "unavailable";
      cacheRead: "miss" | "invalid" | "unavailable" | "error";
    };

export interface AccountBillingSnapshotSources {
  primary(): Promise<PrimaryAccountBillingReadModel>;
  appLimit(): number;
  maxCloudCharacters(creditBalance: number, settings?: unknown): number;
  maxNonTerminalAgents(creditBalance: number | undefined): number;
  maxContainers(creditBalance: number, settings?: unknown): number;
  runtimeTierCache(): Promise<RuntimeTierCacheObservation>;
  autoTopUpRuntimeEnabled(): boolean;
  defaultStorageBytesLimit: bigint;
  now(): Date;
}

const EXPECTED_BILLING_SNAPSHOT_PRIMARY_ERROR_CODES = new Set([
  "ACCOUNT_BILLING_PRIMARY_SOURCE_UNAVAILABLE",
  "INVALID_ACCOUNT_BILLING_PRIMARY_SOURCE",
]);

function isExpectedBillingSnapshotPrimaryFailure(error: unknown): boolean {
  return (
    error instanceof DrizzleError ||
    error instanceof DrizzleQueryError ||
    (error instanceof ElizaError && EXPECTED_BILLING_SNAPSHOT_PRIMARY_ERROR_CODES.has(error.code))
  );
}

function available<T>(source: string, observedAt: string, value: T): Observed<T> {
  return { status: "available", source, observedAt, value };
}

function unavailable<T>(
  source: string,
  observedAt: string,
  code: string,
  retryable: boolean,
): Observed<T> {
  return { status: "unavailable", source, observedAt, error: { code, retryable } };
}

function unknownPolicy<T>(source: string, observedAt: string, blockedBy: string[]): Observed<T> {
  return { status: "unknown_policy", source, observedAt, blockedBy };
}

function notApplicable<T>(source: string, observedAt: string, reason: string): Observed<T> {
  return { status: "not_applicable", source, observedAt, reason };
}

function exactValue(value: string, unit: ExactBillingUnit): ExactBillingValue {
  return {
    value,
    unit,
    ...(unit.startsWith("usd") ? { currency: "USD" as const } : {}),
  };
}

function canonicalInteger(raw: unknown, field: string): string {
  const value = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
  if (!/^\d+$/.test(value)) {
    throw invalidSourceData(`${field} is not an exact non-negative integer`);
  }
  return value.replace(/^0+(?=\d)/, "");
}

function canonicalDecimal(raw: unknown, scale: number, field: string): string {
  const value = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw invalidSourceData(`${field} is not an exact non-negative decimal`);
  }
  const fraction = value.split(".")[1] ?? "";
  if (fraction.slice(scale).replaceAll("0", "").length > 0) {
    throw invalidSourceData(`${field} has precision beyond its authoritative scale`);
  }
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || decimal.isNegative()) {
    throw invalidSourceData(`${field} is not an exact non-negative decimal`);
  }
  return decimal.toFixed(scale);
}

function decimalForQuota(raw: unknown, field: string): number {
  const canonical = canonicalDecimal(raw, 6, field);
  // The landed quota helpers still accept a JS number. This adapter is used
  // only to call those canonical threshold resolvers; the monetary observation
  // and every serialized comparison value remain the exact decimal string.
  const numeric = new Decimal(canonical).toNumber();
  if (!Number.isFinite(numeric)) {
    throw invalidSourceData(`${field} cannot be compared with the quota authority`);
  }
  return numeric;
}

function exactRemaining(limit: string, used: string, reserved: string): string {
  const remaining = BigInt(limit) - BigInt(used) - BigInt(reserved);
  return (remaining > 0n ? remaining : 0n).toString();
}

function observedCountLimit(input: {
  source: string;
  observedAt: string;
  used: string;
  reserved: string;
  deleting: string;
  limit: Observed<ExactBillingValue>;
  policy: LimitCountPolicy;
}): ObservedLimitSnapshot {
  const { source, observedAt, used, reserved, deleting, limit, policy } = input;
  const remaining =
    limit.status === "available"
      ? available(
          source,
          observedAt,
          exactValue(exactRemaining(limit.value.value, used, reserved), "count"),
        )
      : unavailable<ExactBillingValue>(source, observedAt, "limit_unavailable", false);
  return {
    used: available(source, observedAt, exactValue(used, "count")),
    reserved: available(source, observedAt, exactValue(reserved, "count")),
    deleting: available(source, observedAt, exactValue(deleting, "count")),
    limit,
    remaining,
    resetAt: notApplicable(source, observedAt, "lifecycle_count_has_no_periodic_reset"),
    countsTowardLimit: available(source, observedAt, policy),
  };
}

function unavailableLimit(
  source: string,
  observedAt: string,
  code: string,
  retryable: boolean,
): ObservedLimitSnapshot {
  return {
    used: unavailable(source, observedAt, code, retryable),
    reserved: unavailable(source, observedAt, code, retryable),
    deleting: unavailable(source, observedAt, code, retryable),
    limit: unavailable(source, observedAt, code, retryable),
    remaining: unavailable(source, observedAt, code, retryable),
    resetAt: unavailable(source, observedAt, code, retryable),
    countsTowardLimit: unavailable(source, observedAt, code, retryable),
  };
}

function unknownPolicyLimit(
  source: string,
  observedAt: string,
  blockedBy: string[],
): ObservedLimitSnapshot {
  return {
    used: unknownPolicy(source, observedAt, blockedBy),
    reserved: unknownPolicy(source, observedAt, blockedBy),
    deleting: unknownPolicy(source, observedAt, blockedBy),
    limit: unknownPolicy(source, observedAt, blockedBy),
    remaining: unknownPolicy(source, observedAt, blockedBy),
    resetAt: unknownPolicy(source, observedAt, blockedBy),
    countsTowardLimit: unknownPolicy(source, observedAt, blockedBy),
  };
}

function safeV1Integer(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function v1Classify(used: string, limit: string): LimitItemState {
  const usedExact = BigInt(used);
  const limitExact = BigInt(limit);
  if (usedExact > limitExact) return "over-limit";
  if (usedExact === limitExact) return "at-limit";
  return "available";
}

function v1Counted(
  source: string,
  used: string,
  limit: Observed<ExactBillingValue>,
): CountedLimitItem {
  if (limit.status !== "available") {
    return { source, state: "unavailable", reason: "source read failed" };
  }
  const usedNumber = safeV1Integer(used);
  const limitNumber = safeV1Integer(limit.value.value);
  if (usedNumber === null || limitNumber === null || limitNumber <= 0) {
    return { source, state: "unavailable", reason: "source read failed" };
  }
  return {
    source,
    state: v1Classify(used, limit.value.value),
    used: usedNumber,
    limit: limitNumber,
  };
}

function unavailableV1Snapshot(observedAt: string): AccountLimitsSnapshot {
  const counted = (source: string): CountedLimitItem => ({
    source,
    state: "unavailable",
    reason: "source read failed",
  });
  return {
    observedAt,
    cloudCharacters: counted("cloud-character-quota"),
    agentSandboxes: {
      source: "agent-sandbox-quota",
      state: "unavailable",
      reason: "source read failed",
      nonEagerCreate: { state: "unavailable", reason: "source read failed" },
      eagerManagedCreate: { state: "unavailable", reason: "source read failed" },
    },
    containers: counted("container-quota"),
    apps: counted("apps-service"),
    storage: {
      source: "org-storage-quota",
      state: "unavailable",
      reason: "source read failed",
    },
    inferenceRateLimits: {
      source: "org-rate-limits",
      state: "unavailable",
      reason: "source read failed",
    },
  };
}

function allUnavailableV2(
  snapshotStartedAt: string,
  snapshotCompletedAt: string,
  observedAt: string,
): AccountBillingSnapshotV2 {
  const primaryLimit = unavailableLimit(
    "primary-account-billing-snapshot",
    observedAt,
    "primary_source_unavailable",
    true,
  );
  const primary = <T>() =>
    unavailable<T>(
      "primary-account-billing-snapshot",
      observedAt,
      "primary_source_unavailable",
      true,
    );
  return {
    snapshotStartedAt,
    snapshotCompletedAt,
    balance: primary(),
    paymentMethodPresence: primary(),
    billingReadiness: primary(),
    autoTopUp: {
      configuration: primary(),
      runtimeSwitch: primary(),
      control: primary(),
      customerBinding: primary(),
      blockingState: primary(),
      rearm: primary(),
      readiness: primary(),
    },
    tier: {
      configured: primary(),
      eligibilityPolicy: unknownPolicy("org-rate-limits", observedAt, ["#23019"]),
      runtimeCache: unavailable(
        "org-rate-limit-cache",
        observedAt,
        "primary_source_unavailable",
        true,
      ),
    },
    limits: {
      apiKeys: primaryLimit,
      cloudCharacters: primaryLimit,
      agentSandboxes: { nonEagerCreate: primaryLimit, eagerManagedCreate: primaryLimit },
      containers: primaryLimit,
      apps: primaryLimit,
      storage: primaryLimit,
      inference: {
        completions: primaryLimit,
        embeddings: primaryLimit,
        weekly: unknownPolicyLimit("weekly-inference-policy", observedAt, ["#22962"]),
      },
    },
    activeCompute: {
      resources: primary(),
      estimatedRecurringComputeCostPerDay: primary(),
      scope: primary(),
    },
  };
}

async function observeRuntimeTierCache(
  sources: AccountBillingSnapshotSources,
  observedAt: string,
): Promise<AccountBillingSnapshotV2["tier"]["runtimeCache"]> {
  const cache = await sources.runtimeTierCache();
  if (cache.kind === "ready") {
    return available("org-rate-limit-cache", observedAt, {
      selectorKey: cache.tier.tierName,
      completionsRpm: String(cache.tier.completionsRpm),
      embeddingsRpm: String(cache.tier.embeddingsRpm),
      standardRpm: String(cache.tier.standardRpm),
      strictRpm: String(cache.tier.strictRpm),
    });
  }
  return unavailable(
    "org-rate-limit-cache",
    observedAt,
    `runtime_tier_cache_${cache.cacheRead}`,
    true,
  );
}

function observeAutoTopUpRuntimeSwitch(
  sources: AccountBillingSnapshotSources,
  observedAt: string,
): AccountBillingSnapshotV2["autoTopUp"]["runtimeSwitch"] {
  return available("AUTO_TOP_UP_DURABLE_ENABLED", observedAt, {
    enabled: sources.autoTopUpRuntimeEnabled(),
  });
}

function inferenceWindowLimit(
  endpoint: "completions" | "embeddings",
  configuredLimit: Observed<ExactBillingValue>,
  observedAt: string,
): ObservedLimitSnapshot {
  const source = "inference-admission-gate-do";
  return {
    used: unavailable(source, observedAt, "inference_window_peek_unavailable", false),
    reserved: notApplicable(source, observedAt, "request_windows_have_no_reserved_state"),
    deleting: notApplicable(source, observedAt, "request_windows_have_no_deleting_state"),
    limit: configuredLimit,
    remaining: unavailable(source, observedAt, "inference_window_peek_unavailable", false),
    resetAt: unavailable(source, observedAt, "inference_window_peek_unavailable", false),
    countsTowardLimit: available(source, observedAt, {
      included: [
        `valid ${endpoint} /rate-limit checks in the active window, including over-limit checks`,
      ],
      excluded: ["invalid requests rejected before counter mutation"],
    }),
  };
}

const ACTIVE_COMPUTE_RATE_SOURCE = "compute_billing_rate_segments";
const ACTIVE_COMPUTE_BILLING_STATUSES = new Set(["active", "warning", "shutdown_pending"]);

interface ActiveComputeRateResult {
  rateSegment: ActiveComputeResourceSnapshot["rateSegment"];
  ratePerHour: ActiveComputeResourceSnapshot["ratePerHour"];
  estimatedRecurringComputeCostPerDay: ActiveComputeResourceSnapshot["estimatedRecurringComputeCostPerDay"];
  dailyForAggregate: Decimal | null;
}

function unavailableActiveComputeRate(observedAt: string, code: string): ActiveComputeRateResult {
  return {
    rateSegment: unavailable(ACTIVE_COMPUTE_RATE_SOURCE, observedAt, code, false),
    ratePerHour: unavailable(ACTIVE_COMPUTE_RATE_SOURCE, observedAt, code, false),
    estimatedRecurringComputeCostPerDay: unavailable(
      ACTIVE_COMPUTE_RATE_SOURCE,
      observedAt,
      code,
      false,
    ),
    dailyForAggregate: null,
  };
}

function expectedActiveComputeSegment(resource: {
  resourceType: string;
  status: string;
  billingStatus: string;
  metadata: Record<string, unknown>;
}):
  | { workloadKind: "agent" | "container"; billingState: "running" | "backup" }
  | { errorCode: string } {
  if (!ACTIVE_COMPUTE_BILLING_STATUSES.has(resource.billingStatus)) {
    return { errorCode: "active_compute_resource_selector_mismatch" };
  }
  if (resource.resourceType === "container") {
    return resource.status === "running"
      ? { workloadKind: "container", billingState: "running" }
      : { errorCode: "active_compute_resource_selector_mismatch" };
  }
  if (resource.resourceType === "agent_sandbox") {
    if (resource.status === "running") {
      return { workloadKind: "agent", billingState: "running" };
    }
    if (resource.status === "stopped" && typeof resource.metadata.lastBackupAt === "string") {
      return { workloadKind: "agent", billingState: "backup" };
    }
    return { errorCode: "active_compute_resource_selector_mismatch" };
  }
  return { errorCode: "active_compute_resource_kind_invalid" };
}

function observeActiveComputeRate(
  resource: PrimaryAccountBillingReadModel["activeResources"][number],
  rateSegments: PrimaryComputeRateSegment[],
  observedAt: string,
): ActiveComputeRateResult {
  const expected = expectedActiveComputeSegment(resource);
  if ("errorCode" in expected) {
    return unavailableActiveComputeRate(observedAt, expected.errorCode);
  }

  const workloadSegments = rateSegments.filter(
    (segment) => segment.workloadId === resource.resourceId,
  );
  const kindSegments = workloadSegments.filter(
    (segment) => segment.workloadKind === expected.workloadKind,
  );
  if (kindSegments.length === 0) {
    return unavailableActiveComputeRate(
      observedAt,
      workloadSegments.length > 0
        ? "active_compute_rate_segment_kind_mismatch"
        : "active_compute_rate_segment_missing",
    );
  }

  const snapshotTime = Date.parse(observedAt);
  if (!Number.isFinite(snapshotTime)) {
    return unavailableActiveComputeRate(observedAt, "active_compute_snapshot_timestamp_invalid");
  }
  const eligible: Array<{ segment: PrimaryComputeRateSegment; effectiveAt: Date }> = [];
  for (const segment of kindSegments) {
    const effectiveAt =
      segment.effectiveAt instanceof Date ? segment.effectiveAt : new Date(segment.effectiveAt);
    if (!Number.isFinite(effectiveAt.getTime())) {
      return unavailableActiveComputeRate(observedAt, "active_compute_rate_segment_invalid");
    }
    if (effectiveAt.getTime() <= snapshotTime) eligible.push({ segment, effectiveAt });
  }
  if (eligible.length === 0) {
    return unavailableActiveComputeRate(observedAt, "active_compute_rate_segment_future_only");
  }
  eligible.sort((left, right) => right.effectiveAt.getTime() - left.effectiveAt.getTime());
  const { segment, effectiveAt } = eligible[0]!;
  if (segment.billingState !== expected.billingState) {
    return unavailableActiveComputeRate(observedAt, "active_compute_rate_segment_state_mismatch");
  }

  let hourlyExact: string;
  try {
    hourlyExact = canonicalDecimal(
      segment.ratePerHour,
      6,
      "compute_billing_rate_segments.rate_per_hour",
    );
  } catch (error) {
    // error-policy:J4 — malformed canonical segment numerics make only that
    // resource's rate unavailable; unrelated implementation errors escape.
    if (!(error instanceof ElizaError) || error.code !== "INVALID_ACCOUNT_LIMIT_SOURCE") {
      throw error;
    }
    return unavailableActiveComputeRate(observedAt, "active_compute_rate_segment_invalid");
  }
  const dailyExact = new Decimal(hourlyExact).mul(24).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  const rateSegmentValue: ActiveComputeRateSegmentSnapshot = {
    workloadKind: expected.workloadKind,
    billingState: expected.billingState,
    effectiveAt: effectiveAt.toISOString(),
  };
  return {
    rateSegment: available(ACTIVE_COMPUTE_RATE_SOURCE, observedAt, rateSegmentValue),
    ratePerHour: available(ACTIVE_COMPUTE_RATE_SOURCE, observedAt, {
      ...exactValue(hourlyExact, "usd_per_hour"),
      unit: "usd_per_hour",
      currency: "USD",
    }),
    estimatedRecurringComputeCostPerDay: available(ACTIVE_COMPUTE_RATE_SOURCE, observedAt, {
      ...exactValue(dailyExact.toFixed(6), "usd_per_day"),
      unit: "usd_per_day",
      currency: "USD",
    }),
    dailyForAggregate: dailyExact,
  };
}

/**
 * Builds the additive v2 contract and its temporary v1 projection. No source
 * reader in this function mutates a provider, cache, Durable Object, or claim
 * path; externally owned runtime state is cache-only or explicitly unavailable.
 */
export async function buildAccountBillingSnapshot(
  sources: AccountBillingSnapshotSources,
): Promise<AccountBillingSnapshot> {
  const snapshotStartedAt = sources.now().toISOString();
  const switchObservedAt = sources.now().toISOString();
  const runtimeSwitch = observeAutoTopUpRuntimeSwitch(sources, switchObservedAt);
  const cacheObservedAt = sources.now().toISOString();
  // `allSettled` attaches its rejection observer immediately. The outer
  // `finally` also awaits it on every return/throw after this point, so an
  // eager cache rejection can neither become unhandled nor mask a primary or
  // downstream assembly error.
  const runtimeCacheSettlementsPromise = Promise.allSettled([
    observeRuntimeTierCache(sources, cacheObservedAt),
  ] as const);
  try {
    let primary: PrimaryAccountBillingReadModel;
    try {
      primary = await sources.primary();
    } catch (error) {
      // error-policy:J4 — only expected primary read failures become a fully
      // explicit unavailable snapshot; missing tenancy and defects still abort.
      if (error instanceof ElizaError && error.code === "ACCOUNT_BILLING_ORGANIZATION_NOT_FOUND") {
        throw error;
      }
      // Expected source failures become explicit observations. Programming
      // defects must still fail the request so they cannot masquerade as a
      // successfully assembled (but entirely unavailable) snapshot.
      if (!isExpectedBillingSnapshotPrimaryFailure(error)) throw error;
      const observedAt = sources.now().toISOString();
      const [runtimeCacheSettlement] = await runtimeCacheSettlementsPromise;
      // error-policy:J4 — the primary outage remains authoritative. A
      // concurrent cache defect is represented as secondary unavailability
      // instead of replacing that fail-closed primary outcome.
      const runtimeCache: AccountBillingSnapshotV2["tier"]["runtimeCache"] =
        runtimeCacheSettlement.status === "fulfilled"
          ? runtimeCacheSettlement.value
          : unavailable("org-rate-limit-cache", cacheObservedAt, "runtime_tier_cache_error", true);
      const inferenceObservedAt = sources.now().toISOString();
      const snapshotCompletedAt = sources.now().toISOString();
      const v2 = allUnavailableV2(snapshotStartedAt, snapshotCompletedAt, observedAt);
      v2.autoTopUp.runtimeSwitch = runtimeSwitch;
      v2.tier.runtimeCache = runtimeCache;
      const configuredLimit = unavailable<ExactBillingValue>(
        "primary-account-billing-snapshot",
        observedAt,
        "primary_source_unavailable",
        true,
      );
      v2.limits.inference = {
        completions: inferenceWindowLimit("completions", configuredLimit, inferenceObservedAt),
        embeddings: inferenceWindowLimit("embeddings", configuredLimit, inferenceObservedAt),
        weekly: unknownPolicyLimit("weekly-inference-policy", observedAt, ["#22962"]),
      };
      return {
        schemaVersion: 2,
        ...unavailableV1Snapshot(observedAt),
        v2,
      };
    }

    const observedAt = primary.observedAt;
    const balanceSource = "organizations";
    let balance: Observed<
      AccountBillingSnapshotV2["balance"] extends Observed<infer T> ? T : never
    >;
    let balanceForQuota: number | null = null;
    try {
      const amount = canonicalDecimal(
        primary.organization.creditBalance,
        6,
        "organizations.credit_balance",
      );
      balanceForQuota = decimalForQuota(amount, "organizations.credit_balance");
      balance = available(balanceSource, observedAt, {
        balance: { ...exactValue(amount, "usd"), unit: "usd", currency: "USD" },
        revision: canonicalInteger(
          primary.organization.balanceRevision,
          "organizations.balance_revision",
        ),
      });
    } catch (error) {
      // error-policy:J4 — typed balance corruption degrades balance-derived
      // fields without inventing a fallback tier.
      unavailableReason(error);
      balance = unavailable(balanceSource, observedAt, "invalid_balance_authority", false);
    }

    const characterSource = "cloud-character-quota";
    const characterUsed = canonicalInteger(primary.cloudCharacterCount, "cloud character count");
    let characterLimit: Observed<ExactBillingValue>;
    try {
      if (balanceForQuota === null) throw invalidSourceData("balance source unavailable");
      const limit = sources.maxCloudCharacters(balanceForQuota, primary.organization.settings);
      if (!isUsableLimit(limit)) throw invalidSourceData("cloud character limit is invalid");
      characterLimit = available(characterSource, observedAt, exactValue(String(limit), "count"));
    } catch (error) {
      // error-policy:J4 — typed character-cap source failures degrade this cap;
      // unrelated helper defects still escape through unavailableReason.
      unavailableReason(error);
      characterLimit = unavailable(
        characterSource,
        observedAt,
        "character_limit_unavailable",
        false,
      );
    }
    const cloudCharacters = observedCountLimit({
      source: characterSource,
      observedAt,
      used: characterUsed,
      reserved: "0",
      deleting: "0",
      limit: characterLimit,
      policy: {
        included: ["user_characters.source=cloud"],
        excluded: ["user_characters.source!=cloud"],
      },
    });
    cloudCharacters.reserved = notApplicable(
      characterSource,
      observedAt,
      "character_creation_has_no_separate_reserved_lifecycle",
    );
    cloudCharacters.deleting = notApplicable(
      characterSource,
      observedAt,
      "character_deletion_has_no_separate_counted_state",
    );

    const sandboxSource = "agent-sandbox-quota";
    const sandboxUsed = canonicalInteger(primary.sandboxCounts.used, "used sandboxes");
    const sandboxReserved = canonicalInteger(primary.sandboxCounts.reserved, "reserved sandboxes");
    const sandboxDeleting = canonicalInteger(primary.sandboxCounts.deleting, "deleting sandboxes");
    let nonEagerLimit: Observed<ExactBillingValue>;
    let eagerLimit: Observed<ExactBillingValue>;
    try {
      const limit = sources.maxNonTerminalAgents(undefined);
      if (!isUsableLimit(limit)) throw invalidSourceData("non-eager sandbox limit is invalid");
      nonEagerLimit = available(sandboxSource, observedAt, exactValue(String(limit), "count"));
    } catch (error) {
      // error-policy:J4 — typed fixed sandbox-cap failures degrade only this cap.
      unavailableReason(error);
      nonEagerLimit = unavailable(sandboxSource, observedAt, "sandbox_limit_unavailable", false);
    }
    try {
      if (balanceForQuota === null) throw invalidSourceData("balance source unavailable");
      const limit = sources.maxNonTerminalAgents(balanceForQuota);
      if (!isUsableLimit(limit)) throw invalidSourceData("eager sandbox limit is invalid");
      eagerLimit = available(sandboxSource, observedAt, exactValue(String(limit), "count"));
    } catch (error) {
      // error-policy:J4 — typed balance-derived sandbox-cap failures degrade only
      // the eager cap; the non-eager result remains independent.
      unavailableReason(error);
      eagerLimit = unavailable(sandboxSource, observedAt, "sandbox_limit_unavailable", false);
    }
    const sandboxPolicy: LimitCountPolicy = {
      included: ["pending", "provisioning", "running", "stopped", "sleeping"],
      excluded: ["pool rows", "disconnected", "error", "deletion_pending", "deletion_failed"],
    };
    const agentSandboxes = {
      nonEagerCreate: observedCountLimit({
        source: sandboxSource,
        observedAt,
        used: sandboxUsed,
        reserved: sandboxReserved,
        deleting: sandboxDeleting,
        limit: nonEagerLimit,
        policy: sandboxPolicy,
      }),
      eagerManagedCreate: observedCountLimit({
        source: sandboxSource,
        observedAt,
        used: sandboxUsed,
        reserved: sandboxReserved,
        deleting: sandboxDeleting,
        limit: eagerLimit,
        policy: sandboxPolicy,
      }),
    };

    const containerSource = "container-quota";
    const containerUsed = canonicalInteger(primary.containerCounts.used, "used containers");
    const containerReserved = canonicalInteger(
      primary.containerCounts.reserved,
      "reserved containers",
    );
    const containerDeleting = canonicalInteger(
      primary.containerCounts.deleting,
      "deleting containers",
    );
    let containerLimit: Observed<ExactBillingValue>;
    try {
      if (balanceForQuota === null) throw invalidSourceData("balance source unavailable");
      const limit = sources.maxContainers(balanceForQuota, primary.containerSettings);
      if (!isUsableLimit(limit)) throw invalidSourceData("container limit is invalid");
      containerLimit = available(containerSource, observedAt, exactValue(String(limit), "count"));
    } catch (error) {
      // error-policy:J4 — typed container-cap failures are explicit and never
      // replaced with a permissive default.
      unavailableReason(error);
      containerLimit = unavailable(
        containerSource,
        observedAt,
        "container_limit_unavailable",
        false,
      );
    }
    const containerLimits = observedCountLimit({
      source: containerSource,
      observedAt,
      used: containerUsed,
      reserved: containerReserved,
      deleting: containerDeleting,
      limit: containerLimit,
      policy: {
        included: [
          "every containers row whose status is NOT IN ('deleting','deleted')",
          "pending/building/deploying are reported as reserved; every other included status is used",
        ],
        excluded: ["status=deleting", "status=deleted"],
      },
    });

    const appSource = "apps-service";
    const appUsed = canonicalInteger(primary.appCount, "app count");
    let appLimit: Observed<ExactBillingValue>;
    try {
      const limit = sources.appLimit();
      if (!isUsableLimit(limit)) throw invalidSourceData("app limit is invalid");
      appLimit = available(appSource, observedAt, exactValue(String(limit), "count"));
    } catch (error) {
      // error-policy:J4 — typed app-cap configuration failures are explicit;
      // programming defects still abort.
      unavailableReason(error);
      appLimit = unavailable(appSource, observedAt, "app_limit_unavailable", false);
    }
    const appLimits = observedCountLimit({
      source: appSource,
      observedAt,
      used: appUsed,
      reserved: "0",
      deleting: "0",
      limit: appLimit,
      policy: { included: ["all apps rows"], excluded: [] },
    });
    appLimits.reserved = notApplicable(appSource, observedAt, "apps_have_no_reserved_state");
    appLimits.deleting = notApplicable(appSource, observedAt, "apps_have_no_deleting_quota_state");

    const storageSource = "org-storage-quota";
    const storageValueSource =
      primary.storageQuota === null ? "org-storage-quota-default" : storageSource;
    let storageUsed: string | null = null;
    let storageLimitValue: string | null = null;
    try {
      if (primary.storageQuota === null) {
        storageUsed = "0";
        storageLimitValue = canonicalInteger(
          sources.defaultStorageBytesLimit.toString(),
          "default storage bytes limit",
        );
      } else {
        storageUsed = canonicalInteger(primary.storageQuota.bytesUsed, "storage bytes used");
        storageLimitValue = canonicalInteger(
          primary.storageQuota.bytesLimit,
          "storage bytes limit",
        );
      }
    } catch (error) {
      // error-policy:J4 — typed persisted/default quota corruption degrades only
      // storage; unexpected failures still abort snapshot assembly.
      unavailableReason(error);
      storageUsed = null;
      storageLimitValue = null;
    }
    const storageLimits: ObservedLimitSnapshot =
      storageUsed !== null && storageLimitValue !== null
        ? {
            used: available(storageValueSource, observedAt, exactValue(storageUsed, "byte")),
            reserved: unavailable(
              storageValueSource,
              observedAt,
              "storage_reservation_decomposition_unavailable",
              false,
            ),
            deleting: unavailable(
              storageValueSource,
              observedAt,
              "storage_deletion_decomposition_unavailable",
              false,
            ),
            limit: available(storageValueSource, observedAt, exactValue(storageLimitValue, "byte")),
            remaining: available(
              storageValueSource,
              observedAt,
              exactValue(exactRemaining(storageLimitValue, storageUsed, "0"), "byte"),
            ),
            resetAt: notApplicable(
              storageValueSource,
              observedAt,
              "storage_quota_has_no_periodic_reset",
            ),
            countsTowardLimit: available(
              storageValueSource,
              observedAt,
              primary.storageQuota === null
                ? {
                    included: [
                      "zero bytes until first atomic reservation creates org_storage_quota",
                    ],
                    excluded: [],
                  }
                : {
                    included: ["bytes represented by org_storage_quota.bytes_used"],
                    excluded: [],
                  },
            ),
          }
        : unavailableLimit(storageSource, observedAt, "storage_quota_invalid", false);

    const apiKeySource = "api_keys";
    const apiKeyUsed = canonicalInteger(primary.apiKeyCount, "api key count");
    const apiKeyLimits: ObservedLimitSnapshot = {
      used: available(apiKeySource, observedAt, exactValue(apiKeyUsed, "count")),
      reserved: notApplicable(apiKeySource, observedAt, "api_keys_have_no_reserved_state"),
      deleting: notApplicable(apiKeySource, observedAt, "api_key_inventory_is_row_based"),
      limit: unknownPolicy(apiKeySource, observedAt, ["#22958"]),
      remaining: unknownPolicy(apiKeySource, observedAt, ["#22958"]),
      resetAt: unknownPolicy(apiKeySource, observedAt, ["#22958"]),
      countsTowardLimit: unknownPolicy(apiKeySource, observedAt, ["#22958"]),
    };

    let configuredTier: AccountBillingSnapshotV2["tier"]["configured"];
    if (primary.configuredTier.status === "available") {
      const tier = primary.configuredTier;
      configuredTier = available("org-rate-limits", observedAt, {
        selectorKey: tier.tier.tierName,
        tierSourceCreditTotalObserved: {
          ...exactValue(
            canonicalDecimal(tier.tierSourceCreditTotal, 6, "tier-source credit total observed"),
            "usd",
          ),
          unit: "usd",
          currency: "USD",
        },
        overrides: {
          completionsRpm:
            tier.overrides.completionsRpm === null ? null : String(tier.overrides.completionsRpm),
          embeddingsRpm:
            tier.overrides.embeddingsRpm === null ? null : String(tier.overrides.embeddingsRpm),
          standardRpm:
            tier.overrides.standardRpm === null ? null : String(tier.overrides.standardRpm),
          strictRpm: tier.overrides.strictRpm === null ? null : String(tier.overrides.strictRpm),
        },
        completionsRpm: String(tier.tier.completionsRpm),
        embeddingsRpm: String(tier.tier.embeddingsRpm),
        standardRpm: String(tier.tier.standardRpm),
        strictRpm: String(tier.tier.strictRpm),
      });
    } else {
      configuredTier = unavailable(
        "org-rate-limits",
        observedAt,
        primary.configuredTier.code,
        false,
      );
    }

    const inferenceObservedAt = sources.now().toISOString();
    const configuredInferenceLimit = (
      endpoint: "completions" | "embeddings",
    ): Observed<ExactBillingValue> =>
      configuredTier.status === "available"
        ? available(
            "org-rate-limits",
            observedAt,
            exactValue(
              endpoint === "completions"
                ? configuredTier.value.completionsRpm
                : configuredTier.value.embeddingsRpm,
              "request_per_minute",
            ),
          )
        : unavailable("org-rate-limits", observedAt, "configured_tier_unavailable", false);
    const inference = {
      completions: inferenceWindowLimit(
        "completions",
        configuredInferenceLimit("completions"),
        inferenceObservedAt,
      ),
      embeddings: inferenceWindowLimit(
        "embeddings",
        configuredInferenceLimit("embeddings"),
        inferenceObservedAt,
      ),
      weekly: unknownPolicyLimit("weekly-inference-policy", observedAt, ["#22962"]),
    };

    const [runtimeCacheSettlement] = await runtimeCacheSettlementsPromise;
    if (runtimeCacheSettlement.status === "rejected") {
      throw runtimeCacheSettlement.reason;
    }
    const runtimeCache = runtimeCacheSettlement.value;

    const paymentPresence = available("organizations", observedAt, {
      customerIdPresent: primary.organization.stripeCustomerIdPresent,
      defaultPaymentMethodIdPresent: primary.organization.defaultPaymentMethodIdPresent,
    });
    const billingBlockers: BillingReadinessBlockerCode[] = [];
    if (!primary.organization.stripeCustomerIdPresent) {
      billingBlockers.push("missing_customer_id");
    } else if (!primary.organization.stripeCustomerIdValid) {
      billingBlockers.push("invalid_customer_id");
    }
    if (!primary.organization.defaultPaymentMethodIdPresent) {
      billingBlockers.push("missing_default_payment_method_id");
    } else if (!primary.organization.defaultPaymentMethodIdValid) {
      billingBlockers.push("invalid_default_payment_method_id");
    }
    if (!primary.autoTopUp.customerBindingAuthoritative) {
      billingBlockers.push("customer_binding_not_authoritative");
    }
    const billingReadiness = available(
      "organizations+stripe-customer-binding-authority",
      observedAt,
      {
        ready: billingBlockers.length === 0,
        blockers: billingBlockers,
      },
    );

    let autoTopUpConfiguration: AccountBillingSnapshotV2["autoTopUp"]["configuration"];
    try {
      autoTopUpConfiguration = available("organizations", observedAt, {
        accountActive: primary.organization.isActive,
        enabled: primary.organization.autoTopUpEnabled,
        threshold:
          primary.organization.autoTopUpThreshold === null
            ? null
            : {
                ...exactValue(
                  canonicalDecimal(
                    primary.organization.autoTopUpThreshold,
                    2,
                    "auto top-up threshold",
                  ),
                  "usd",
                ),
                unit: "usd",
                currency: "USD",
              },
        amount:
          primary.organization.autoTopUpAmount === null
            ? null
            : {
                ...exactValue(
                  canonicalDecimal(primary.organization.autoTopUpAmount, 2, "auto top-up amount"),
                  "usd",
                ),
                unit: "usd",
                currency: "USD",
              },
      });
    } catch (error) {
      // error-policy:J4 — malformed persisted auto-top-up values degrade the
      // configuration/readiness observations without changing common billing readiness.
      unavailableReason(error);
      autoTopUpConfiguration = unavailable(
        "organizations",
        observedAt,
        "auto_top_up_configuration_invalid",
        false,
      );
    }
    const control = primary.autoTopUp.control
      ? available("auto_top_up_control", observedAt, {
          mode: primary.autoTopUp.control.mode,
          pausedAt: primary.autoTopUp.control.pausedAt.toISOString(),
          legacyReconciledThrough:
            primary.autoTopUp.control.legacyReconciledThrough?.toISOString() ?? null,
        })
      : unavailable<
          AccountBillingSnapshotV2["autoTopUp"]["control"] extends Observed<infer T> ? T : never
        >("auto_top_up_control", observedAt, "auto_top_up_control_missing", false);
    const customerBinding = available("stripe-customer-binding-authority", observedAt, {
      authoritative: primary.autoTopUp.customerBindingAuthoritative,
    });
    const blockingState = available("auto_top_up_attempts+legacy_quarantine", observedAt, {
      durableAttempt: primary.autoTopUp.blockingAttempt,
      legacyQuarantine: primary.autoTopUp.blockingLegacyQuarantine,
    });
    const coveredRevision = primary.organization.coveredBalanceDecreaseRevision;
    const rearmed =
      coveredRevision === null ||
      BigInt(primary.organization.balanceDecreaseRevision) > BigInt(coveredRevision);
    const rearm = available("organizations", observedAt, {
      balanceDecreaseRevision: primary.organization.balanceDecreaseRevision,
      coveredBalanceDecreaseRevision: coveredRevision,
      rearmed,
    });

    let autoTopUpReadiness: AccountBillingSnapshotV2["autoTopUp"]["readiness"];
    if (
      autoTopUpConfiguration.status !== "available" ||
      runtimeSwitch.status !== "available" ||
      control.status !== "available" ||
      balance.status !== "available"
    ) {
      autoTopUpReadiness = unavailable(
        "auto-top-up-readiness",
        sources.now().toISOString(),
        "auto_top_up_readiness_incomplete",
        false,
      );
    } else {
      const config = autoTopUpConfiguration.value;
      const threshold = config.threshold === null ? null : new Decimal(config.threshold.value);
      const amount = config.amount === null ? null : new Decimal(config.amount.value);
      const thresholdValid = threshold !== null && threshold.gte(0) && threshold.lte(1000);
      const amountValid = amount !== null && amount.gte(1) && amount.lte(1000);
      const belowThreshold =
        thresholdValid && new Decimal(balance.value.balance.value).lt(threshold!);
      const blockers: AutoTopUpReadinessBlockerCode[] = [...billingBlockers];
      if (!config.accountActive) blockers.push("inactive_organization");
      if (!config.enabled) blockers.push("disabled_by_organization");
      if (config.threshold === null) blockers.push("missing_threshold");
      else if (!thresholdValid) blockers.push("invalid_threshold");
      if (config.amount === null) blockers.push("missing_amount");
      else if (!amountValid) blockers.push("invalid_amount");
      if (thresholdValid && !belowThreshold) blockers.push("balance_at_or_above_threshold");
      if (!runtimeSwitch.value.enabled) blockers.push("runtime_switch_disabled");
      if (control.value.mode !== "durable") blockers.push("cutover_paused");
      if (primary.autoTopUp.blockingAttempt) blockers.push("blocking_attempt");
      if (primary.autoTopUp.blockingLegacyQuarantine) blockers.push("legacy_quarantine");
      if (!rearmed) blockers.push("balance_not_rearmed");
      autoTopUpReadiness = available("auto-top-up-readiness", sources.now().toISOString(), {
        canStartNewAttempt: blockers.length === 0,
        blockers,
      });
    }

    let totalDaily = new Decimal(0);
    let activeRateIncomplete = false;
    const resources: ActiveComputeResourceSnapshot[] = primary.activeResources.map((resource) => {
      const rate = observeActiveComputeRate(resource, primary.latestRateSegments, observedAt);
      if (rate.dailyForAggregate === null) {
        activeRateIncomplete = true;
      } else {
        totalDaily = totalDaily.plus(rate.dailyForAggregate);
      }
      return {
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
        name: resource.name,
        status: resource.status,
        billingStatus: resource.billingStatus,
        billingInterval: resource.billingInterval,
        lastBilledAt: resource.lastBilledAt,
        nextBillingAt: resource.nextBillingAt,
        estimatedNextBillingAt: resource.estimatedNextBillingAt,
        rateSegment: rate.rateSegment,
        ratePerHour: rate.ratePerHour,
        estimatedRecurringComputeCostPerDay: rate.estimatedRecurringComputeCostPerDay,
      };
    });
    const activeResources = available("active-billing-service", observedAt, resources);
    const activeDailyCost: AccountBillingSnapshotV2["activeCompute"]["estimatedRecurringComputeCostPerDay"] =
      activeRateIncomplete
        ? unavailable(
            ACTIVE_COMPUTE_RATE_SOURCE,
            observedAt,
            "active_compute_rate_incomplete",
            false,
          )
        : available(ACTIVE_COMPUTE_RATE_SOURCE, observedAt, {
            ...exactValue(
              totalDaily.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6),
              "usd_per_day",
            ),
            unit: "usd_per_day",
            currency: "USD",
          });

    const snapshotCompletedAt = sources.now().toISOString();
    const v2: AccountBillingSnapshotV2 = {
      snapshotStartedAt,
      snapshotCompletedAt,
      balance,
      paymentMethodPresence: paymentPresence,
      billingReadiness,
      autoTopUp: {
        configuration: autoTopUpConfiguration,
        runtimeSwitch,
        control,
        customerBinding,
        blockingState,
        rearm,
        readiness: autoTopUpReadiness,
      },
      tier: {
        configured: configuredTier,
        eligibilityPolicy: unknownPolicy("org-rate-limits", observedAt, ["#23019"]),
        runtimeCache,
      },
      limits: {
        apiKeys: apiKeyLimits,
        cloudCharacters,
        agentSandboxes,
        containers: containerLimits,
        apps: appLimits,
        storage: storageLimits,
        inference,
      },
      activeCompute: {
        resources: activeResources,
        estimatedRecurringComputeCostPerDay: activeDailyCost,
        scope: available("active-billing-service", observedAt, {
          organizationScoped: true,
          selectors: {
            containers: {
              lifecycleStatuses: ["running"],
              billingStatuses: ["active", "warning", "shutdown_pending"],
            },
            agentSandboxes: {
              excludedExecutionTiers: ["shared"],
              lifecyclePredicates: [
                { status: "running", requiresLastBackup: false },
                { status: "stopped", requiresLastBackup: true },
              ],
              billingStatuses: ["active", "warning", "shutdown_pending"],
            },
          },
          rateAuthority: {
            source: "compute_billing_rate_segments",
            selection: "latest_effective_at_or_before_primary_transaction",
          },
        }),
      },
    };

    const cloudV1 = v1Counted(characterSource, characterUsed, characterLimit);
    const sandboxCounted = (BigInt(sandboxUsed) + BigInt(sandboxReserved)).toString();
    const nonEagerV1 = v1Counted(sandboxSource, sandboxCounted, nonEagerLimit);
    const eagerV1 = v1Counted(sandboxSource, sandboxCounted, eagerLimit);
    const agentV1: SandboxLimitItem = {
      source: sandboxSource,
      ...(safeV1Integer(sandboxCounted) === null ? {} : { used: safeV1Integer(sandboxCounted)! }),
      nonEagerCreate: {
        state: nonEagerV1.state,
        ...(nonEagerV1.limit === undefined ? {} : { limit: nonEagerV1.limit }),
        ...(nonEagerV1.reason === undefined ? {} : { reason: nonEagerV1.reason }),
      },
      eagerManagedCreate: {
        state: eagerV1.state,
        ...(eagerV1.limit === undefined ? {} : { limit: eagerV1.limit }),
        ...(eagerV1.reason === undefined ? {} : { reason: eagerV1.reason }),
      },
      state: eagerV1.state,
      ...(nonEagerV1.limit === undefined ? {} : { nonEagerCreateLimit: nonEagerV1.limit }),
      ...(eagerV1.limit === undefined ? {} : { eagerManagedCreateLimit: eagerV1.limit }),
      ...(eagerV1.reason === undefined ? {} : { reason: eagerV1.reason }),
    };
    const containerCounted = (BigInt(containerUsed) + BigInt(containerReserved)).toString();
    const containerV1 = v1Counted(containerSource, containerCounted, containerLimit);
    const appsV1 = v1Counted(appSource, appUsed, appLimit);
    // Project only the values that passed the same canonical validation as v2.
    // In particular, a malformed lazy-row default must not become a plausible
    // v1 limit merely because the organization has no persisted row yet.
    const storageProjectionUsed = storageUsed;
    const storageProjectionLimit = storageLimitValue;
    const storageV1: StorageLimitItem =
      storageProjectionUsed !== null && storageProjectionLimit !== null
        ? {
            source: storageSource,
            state: v1Classify(storageProjectionUsed, storageProjectionLimit),
            bytesUsed: storageProjectionUsed,
            bytesLimit: storageProjectionLimit,
          }
        : { source: storageSource, state: "unavailable", reason: "source read failed" };
    const inferenceV1: InferenceRateLimitItem =
      configuredTier.status === "available"
        ? {
            source: "org-rate-limits",
            state: "available",
            completionsRpm: Number(configuredTier.value.completionsRpm),
            embeddingsRpm: Number(configuredTier.value.embeddingsRpm),
          }
        : {
            source: "org-rate-limits",
            state: "unavailable",
            reason: "source read failed",
          };

    return {
      schemaVersion: 2,
      observedAt,
      cloudCharacters: cloudV1,
      agentSandboxes: agentV1,
      containers: containerV1,
      apps: appsV1,
      storage: storageV1,
      inferenceRateLimits: inferenceV1,
      v2,
    };
  } finally {
    // `Promise.allSettled` itself cannot reject. Awaiting it here guarantees
    // the cache reader has terminated before any assembly exit is observable.
    await runtimeCacheSettlementsPromise;
  }
}

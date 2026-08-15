/**
 * Read-only, organization-scoped snapshot of the account limits the Cloud
 * backend actually enforces today (#19777): Cloud characters, managed agent
 * sandboxes, containers, apps, quota-accounted upload storage, and the
 * configured per-minute inference caps.
 *
 * Contract rules this module owns:
 *  - every ceiling comes from the SAME canonical helper its create-time
 *    enforcement uses (`getMaxCloudCharactersForOrg`,
 *    `getMaxNonTerminalAgentsForOrg`, container quota repository, apps
 *    service, `org_storage_quota` row, org rate tier) — never a re-derived
 *    number that can drift;
 *  - each item names its server source and carries an explicit
 *    available / at-limit / over-limit / unavailable state;
 *  - a source that cannot be read becomes a visibly distinct `unavailable`
 *    item with a reason — never a free-tier value, zero usage, or
 *    success-by-default;
 *  - storage bytes serialize as exact decimal strings (bigint-safe);
 *  - no `canCreate` boolean: the sandbox item reports the non-eager create
 *    ceiling and the balance-tiered eager managed-create ceiling separately
 *    and leaves the decision to the enforcing route.
 */

export type LimitItemState = "available" | "at-limit" | "over-limit" | "unavailable";

export interface CountedLimitItem {
  /** Server module that owns the create-time enforcement of this ceiling. */
  source: string;
  state: LimitItemState;
  used?: number;
  limit?: number;
  /** Present only when `state` is `unavailable`. */
  reason?: string;
}

export interface SandboxLimitItem {
  source: string;
  state: LimitItemState;
  /** Quota-holding (non-pool, counted-status) sandboxes right now. */
  used?: number;
  /**
   * Ceiling applied to non-eager (plain/shared) user-facing creates. Derived
   * from the canonical balance-tier helper the create routes call.
   */
  nonEagerCreateLimit?: number;
  /**
   * Ceiling applied to the eager managed-create path (provisioning worker),
   * derived from the same balance-tier helper — reported separately because
   * the enforcing routes gate it behind their own credit checks.
   */
  eagerManagedCreateLimit?: number;
  reason?: string;
}

export interface StorageLimitItem {
  source: string;
  state: LimitItemState;
  /** Exact decimal string of bytes used (bigint-safe). */
  bytesUsed?: string;
  /** Exact decimal string of the byte ceiling (bigint-safe). */
  bytesLimit?: string;
  reason?: string;
}

export interface InferenceRateLimitItem {
  source: string;
  state: LimitItemState;
  /** Configured per-minute completions cap for this org's tier + overrides. */
  completionsRpm?: number;
  /** Configured per-minute embeddings cap for this org's tier + overrides. */
  embeddingsRpm?: number;
  reason?: string;
}

export interface AccountLimitsSnapshot {
  /** Single observation timestamp for every item in this snapshot. */
  observedAt: string;
  cloudCharacters: CountedLimitItem;
  agentSandboxes: SandboxLimitItem;
  containers: CountedLimitItem;
  apps: CountedLimitItem;
  storage: StorageLimitItem;
  inferenceRateLimits: InferenceRateLimitItem;
}

/**
 * Injected readers. Each maps 1:1 onto the enforcement source it mirrors; the
 * route wires the real services, and tests can fail any single source to
 * prove isolation.
 */
export interface AccountLimitsSources {
  /** Org billing row: credit balance and settings (for ceiling overrides). */
  orgBilling(): Promise<{
    creditBalance: number;
    settings?: Record<string, unknown>;
  }>;
  /** Count of Cloud characters (`user_characters` with source=cloud). */
  cloudCharacterCount(): Promise<number>;
  /** Count of quota-holding (counted-status, non-pool) agent sandboxes. */
  sandboxQuotaCount(): Promise<number>;
  /** Container quota check — the same repository call the create path uses. */
  containerQuota(): Promise<{ current: number; max: number }>;
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
  maxCloudCharacters(creditBalance: number, settings?: Record<string, unknown>): number;
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
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function unavailableReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  let billing: { creditBalance: number; settings?: Record<string, unknown> } | { error: unknown };
  try {
    const row = await sources.orgBilling();
    if (!Number.isFinite(Number(row.creditBalance))) {
      throw new Error("organization credit balance is not a number");
    }
    billing = row;
  } catch (error) {
    // error-policy:J4 — the org row failing must surface as unavailable
    // ceilings, never as a free-tier default.
    billing = { error };
  }

  const cloudCharacters: CountedLimitItem = await (async () => {
    const source = "cloud-character-quota";
    try {
      const used = await sources.cloudCharacterCount();
      if (!isUsableCount(used)) {
        throw new Error("cloud character count is not a usable number");
      }
      if ("error" in billing) {
        return {
          source,
          state: "unavailable" as const,
          reason: unavailableReason(billing.error),
        };
      }
      const limit = sources.maxCloudCharacters(billing.creditBalance, billing.settings);
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
    try {
      const used = await sources.sandboxQuotaCount();
      if (!isUsableCount(used)) {
        throw new Error("sandbox quota count is not a usable number");
      }
      if ("error" in billing) {
        return {
          source,
          state: "unavailable" as const,
          reason: unavailableReason(billing.error),
        };
      }
      const ceiling = sources.maxNonTerminalAgents(billing.creditBalance);
      return {
        source,
        state: classify(used, ceiling),
        used,
        nonEagerCreateLimit: ceiling,
        eagerManagedCreateLimit: ceiling,
      };
    } catch (error) {
      // error-policy:J4 — see above.
      return {
        source,
        state: "unavailable" as const,
        reason: unavailableReason(error),
      };
    }
  })();

  const containers: CountedLimitItem = await (async () => {
    const source = "container-quota";
    try {
      const quota = await sources.containerQuota();
      if (!isUsableCount(quota.current) || !isUsableCount(quota.max)) {
        throw new Error("container quota returned non-numeric values");
      }
      return {
        source,
        state: classify(quota.current, quota.max),
        used: quota.current,
        limit: quota.max,
      };
    } catch (error) {
      // error-policy:J4 — see above.
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
      if (!isUsableCount(used) || !isUsableCount(limit)) {
        throw new Error("app count or limit is not a usable number");
      }
      return { source, state: classify(used, limit), used, limit };
    } catch (error) {
      // error-policy:J4 — see above.
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
        return {
          source,
          state: "available" as const,
          bytesUsed: "0",
          bytesLimit: sources.defaultStorageBytesLimit.toString(),
        };
      }
      if (typeof row.bytesUsed !== "bigint" || typeof row.bytesLimit !== "bigint") {
        throw new Error("storage quota row returned non-bigint bytes");
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
      // error-policy:J4 — see above.
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
      if (!isUsableCount(tier.completionsRpm) || !isUsableCount(tier.embeddingsRpm)) {
        throw new Error("org rate tier returned non-numeric caps");
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
      // error-policy:J4 — see above.
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

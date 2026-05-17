/**
 * Multi-account selection brain.
 *
 * Owns the runtime decision "which `LinkedAccountConfig` should serve this
 * request?" given a strategy (priority / round-robin / least-used /
 * quota-aware), session affinity, and per-account health state.
 *
 * The pool never reads OAuth credentials directly — callers resolve them
 * via `getAccessToken(providerId, accountId)` from `@elizaos/agent` once
 * the pool returns an account. Health, priority, and usage live in this
 * layer; the OAuth blob lives under `~/.eliza/auth/` (see `account-storage.ts`
 * in `@elizaos/agent`).
 *
 * Persistence: the pool layers rich metadata (priority, enabled, health,
 * usage) on top of the credential records from `@elizaos/agent`. The
 * metadata is written to `<ELIZA_HOME>/auth/_pool-metadata.json` atomically
 * so it survives process restarts.
 */
import type {
  LinkedAccountConfig,
  LinkedAccountProviderId,
  LinkedAccountsConfig,
} from "@elizaos/shared";
export type Strategy =
  | "priority"
  | "round-robin"
  | "least-used"
  | "quota-aware";
export type PoolProviderId = LinkedAccountProviderId;
export interface AccountPoolDeps {
  /** Read the current `LinkedAccountsConfig` (live). */
  readAccounts: () => Record<string, LinkedAccountConfig>;
  /** Persist a single account's mutated fields. */
  writeAccount: (account: LinkedAccountConfig) => Promise<void>;
  /** Remove the metadata overlay for an account. */
  deleteAccount?: (
    providerId: PoolProviderId,
    accountId: string,
  ) => Promise<void>;
}
export interface SelectInput {
  providerId: PoolProviderId;
  /** Stable session key for affinity (e.g. agent id + run id). */
  sessionKey?: string;
  /** Defaults to `"priority"`. */
  strategy?: Strategy;
  /** Explicit pool; defaults to all enabled accounts for `providerId`. */
  accountIds?: string[];
  /** Account IDs to skip (e.g. just-failed accounts). */
  exclude?: string[];
}
interface AccountPoolSelectionRoute {
  backend?: string;
  accountId?: string;
  accountIds?: string[];
  strategy?: string;
}
interface AccountPoolSelectionConfig {
  accountStrategies?: Partial<Record<PoolProviderId, unknown>>;
  serviceRouting?: {
    llmText?: AccountPoolSelectionRoute;
  } | null;
}
export declare class AccountPool {
  private readonly deps;
  private readonly affinity;
  private readonly roundRobinCursor;
  constructor(deps: AccountPoolDeps);
  select(input: SelectInput): Promise<LinkedAccountConfig | null>;
  private filterEligible;
  private applyStrategy;
  list(providerId?: PoolProviderId): LinkedAccountConfig[];
  get(
    accountId: string,
    providerId?: PoolProviderId,
  ): LinkedAccountConfig | null;
  upsert(account: LinkedAccountConfig): Promise<void>;
  deleteMetadata(providerId: PoolProviderId, accountId: string): Promise<void>;
  recordCall(
    accountId: string,
    result: {
      tokens?: number;
      latencyMs?: number;
      ok: boolean;
      errorCode?: string;
      model?: string;
    },
    opts?: {
      providerId?: PoolProviderId;
    },
  ): Promise<void>;
  refreshUsage(
    accountId: string,
    accessToken: string,
    opts?: {
      codexAccountId?: string;
      fetch?: typeof fetch;
      providerId?: PoolProviderId;
    },
  ): Promise<void>;
  markRateLimited(
    accountId: string,
    untilMs: number,
    detail?: string,
    opts?: {
      providerId?: PoolProviderId;
    },
  ): Promise<void>;
  markNeedsReauth(
    accountId: string,
    detail?: string,
    opts?: {
      providerId?: PoolProviderId;
    },
  ): Promise<void>;
  markInvalid(
    accountId: string,
    detail?: string,
    opts?: {
      providerId?: PoolProviderId;
    },
  ): Promise<void>;
  markHealthy(
    accountId: string,
    opts?: {
      providerId?: PoolProviderId;
    },
  ): Promise<void>;
  /**
   * Re-probe accounts whose `health` is non-OK and whose `healthDetail.until`
   * has passed (or is absent). Used by background sweepers to recover
   * temporarily flagged accounts. We don't load access tokens here — the
   * caller probes via `refreshUsage` separately.
   */
  reprobeFlagged(): Promise<string[]>;
}
export declare function __getDefaultAccountPoolSelectionForTests(
  providerId: PoolProviderId,
): {
  strategy?: Strategy;
  accountIds?: string[];
};
export declare function configureDefaultAccountPoolSelection(
  config?: AccountPoolSelectionConfig,
): void;
/**
 * Module-level singleton for the default pool wired against `@elizaos/agent`'s
 * account-storage and the pool-owned metadata file. Plugins and runtime
 * resolvers should import `getDefaultAccountPool()` rather than constructing
 * a new pool directly.
 */
export declare function getDefaultAccountPool(): AccountPool;
export declare function applyAccountPoolApiCredentials(opts?: {
  activeBackend?: string | null;
  accountStrategies?: AccountPoolSelectionConfig["accountStrategies"];
  serviceRouting?: AccountPoolSelectionConfig["serviceRouting"];
}): Promise<void>;
export interface AccountPoolKeepAliveResult {
  checked: number;
  refreshed: number;
  failed: number;
}
export declare function sweepAccountPoolKeepAlive(): Promise<AccountPoolKeepAliveResult>;
export declare function startAccountPoolKeepAlive(intervalMs?: number): void;
export declare function stopAccountPoolKeepAliveForTests(): void;
/**
 * Resets the cached singleton. Test-only.
 */
export declare function __resetDefaultAccountPoolForTests(): void;
export type { LinkedAccountsConfig };
//# sourceMappingURL=account-pool.d.ts.map

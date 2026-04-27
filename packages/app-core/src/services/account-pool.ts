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
 * layer; the OAuth blob lives under `~/.eliza/auth/` (see WS1's
 * `account-storage.ts`).
 *
 * Persistence: the pool layers rich metadata (priority, enabled, health,
 * usage) on top of WS1's credential records. The metadata is written to
 * `<ELIZA_HOME>/auth/_pool-metadata.json` atomically so it survives
 * process restarts and is independent of WS3's eventual `milady.json`
 * field — when WS3 lands its CRUD API on top of `LinkedAccountsConfig`
 * we can swap `createDefaultAccountPool()`'s deps without touching the
 * pool itself.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AccountCredentialRecord,
  listProviderAccounts,
  type SubscriptionProvider,
} from "@elizaos/agent";
import type {
  LinkedAccountConfig,
  LinkedAccountHealth,
  LinkedAccountHealthDetail,
  LinkedAccountProviderId,
  LinkedAccountUsage,
  LinkedAccountsConfig,
} from "@elizaos/shared";
import {
  pollAnthropicUsage,
  pollCodexUsage,
  recordCall as recordUsageEntry,
} from "./account-usage.js";

export type Strategy =
  | "priority"
  | "round-robin"
  | "least-used"
  | "quota-aware";

export type PoolProviderId =
  | LinkedAccountProviderId
  | "anthropic-api"
  | "openai-api";

export interface AccountPoolDeps {
  /** Read the current `LinkedAccountsConfig` (live). */
  readAccounts: () => Record<string, LinkedAccountConfig>;
  /** Persist a single account's mutated fields. */
  writeAccount: (account: LinkedAccountConfig) => Promise<void>;
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

interface AffinityEntry {
  accountId: string;
  attempts: number;
}

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;
const QUOTA_AWARE_SKIP_PCT = 85;
const SESSION_AFFINITY_MAX_ATTEMPTS = 3;

export class AccountPool {
  private readonly deps: AccountPoolDeps;
  private readonly affinity = new Map<string, AffinityEntry>();
  private readonly roundRobinCursor = new Map<PoolProviderId, number>();

  constructor(deps: AccountPoolDeps) {
    this.deps = deps;
  }

  // Selection.

  async select(input: SelectInput): Promise<LinkedAccountConfig | null> {
    const all = this.deps.readAccounts();
    const eligible = this.filterEligible(all, input);
    if (eligible.length === 0) return null;

    if (input.sessionKey) {
      const cached = this.affinity.get(input.sessionKey);
      if (
        cached &&
        cached.attempts < SESSION_AFFINITY_MAX_ATTEMPTS &&
        eligible.some((a) => a.id === cached.accountId)
      ) {
        cached.attempts += 1;
        const account = eligible.find((a) => a.id === cached.accountId);
        if (account) return account;
      }
    }

    const strategy: Strategy = input.strategy ?? "priority";
    const picked = this.applyStrategy(strategy, eligible, input.providerId);
    if (!picked) return null;

    if (input.sessionKey) {
      this.affinity.set(input.sessionKey, {
        accountId: picked.id,
        attempts: 1,
      });
    }
    return picked;
  }

  private filterEligible(
    all: Record<string, LinkedAccountConfig>,
    input: SelectInput,
  ): LinkedAccountConfig[] {
    const exclude = new Set(input.exclude ?? []);
    const explicit = input.accountIds && input.accountIds.length > 0
      ? new Set(input.accountIds)
      : null;
    const now = Date.now();

    return Object.values(all).filter((account) => {
      if (account.providerId !== input.providerId) return false;
      if (!account.enabled) return false;
      if (exclude.has(account.id)) return false;
      if (explicit && !explicit.has(account.id)) return false;
      if (account.health === "ok") return true;
      // Allow rate-limited accounts back in once their reset has passed.
      if (
        account.health === "rate-limited" &&
        typeof account.healthDetail?.until === "number" &&
        account.healthDetail.until < now
      ) {
        return true;
      }
      return false;
    });
  }

  private applyStrategy(
    strategy: Strategy,
    eligible: LinkedAccountConfig[],
    providerId: PoolProviderId,
  ): LinkedAccountConfig | null {
    if (eligible.length === 0) return null;
    if (eligible.length === 1) return eligible[0] ?? null;

    switch (strategy) {
      case "round-robin": {
        const sorted = [...eligible].sort(byPriorityThenAge);
        const cursor = (this.roundRobinCursor.get(providerId) ?? -1) + 1;
        const index = cursor % sorted.length;
        this.roundRobinCursor.set(providerId, index);
        return sorted[index] ?? null;
      }
      case "least-used": {
        return [...eligible].sort(byLeastUsedThenPriority)[0] ?? null;
      }
      case "quota-aware": {
        const underQuota = eligible.filter(
          (a) => (a.usage?.sessionPct ?? 0) < QUOTA_AWARE_SKIP_PCT,
        );
        const pool = underQuota.length > 0 ? underQuota : eligible;
        return [...pool].sort(byPriorityThenAge)[0] ?? null;
      }
      default:
        return [...eligible].sort(byPriorityThenAge)[0] ?? null;
    }
  }

  // Mutations.

  async recordCall(
    accountId: string,
    result: {
      tokens?: number;
      latencyMs?: number;
      ok: boolean;
      errorCode?: string;
      model?: string;
    },
  ): Promise<void> {
    const account = this.deps.readAccounts()[accountId];
    if (!account) return;
    recordUsageEntry(account.providerId, account.id, result);
    const next: LinkedAccountConfig = {
      ...account,
      lastUsedAt: Date.now(),
    };
    await this.deps.writeAccount(next);
  }

  async refreshUsage(
    accountId: string,
    accessToken: string,
    opts?: { codexAccountId?: string },
  ): Promise<void> {
    const account = this.deps.readAccounts()[accountId];
    if (!account) return;

    let usage: LinkedAccountUsage;
    if (account.providerId === "anthropic-subscription") {
      usage = await pollAnthropicUsage(accessToken);
    } else if (account.providerId === "openai-codex") {
      const codexAccountId = opts?.codexAccountId ?? account.organizationId;
      if (!codexAccountId) {
        throw new Error(
          `[AccountPool] Codex usage probe needs the OpenAI account_id (account ${accountId} has no organizationId).`,
        );
      }
      usage = await pollCodexUsage(accessToken, codexAccountId);
    } else {
      // No probe defined for direct API providers.
      return;
    }

    await this.deps.writeAccount({
      ...account,
      health: "ok",
      usage,
    });
  }

  async markRateLimited(
    accountId: string,
    untilMs: number,
    detail?: string,
  ): Promise<void> {
    const account = this.deps.readAccounts()[accountId];
    if (!account) return;
    const healthDetail: LinkedAccountHealthDetail = {
      until:
        Number.isFinite(untilMs) && untilMs > Date.now()
          ? untilMs
          : Date.now() + DEFAULT_RATE_LIMIT_BACKOFF_MS,
      lastChecked: Date.now(),
      ...(detail ? { lastError: detail } : {}),
    };
    await this.deps.writeAccount({
      ...account,
      health: "rate-limited",
      healthDetail,
    });
  }

  async markNeedsReauth(accountId: string, detail?: string): Promise<void> {
    const account = this.deps.readAccounts()[accountId];
    if (!account) return;
    await this.deps.writeAccount({
      ...account,
      health: "needs-reauth",
      healthDetail: {
        lastChecked: Date.now(),
        ...(detail ? { lastError: detail } : {}),
      },
    });
  }

  async markInvalid(accountId: string, detail?: string): Promise<void> {
    const account = this.deps.readAccounts()[accountId];
    if (!account) return;
    await this.deps.writeAccount({
      ...account,
      health: "invalid",
      healthDetail: {
        lastChecked: Date.now(),
        ...(detail ? { lastError: detail } : {}),
      },
    });
  }

  async markHealthy(accountId: string): Promise<void> {
    const account = this.deps.readAccounts()[accountId];
    if (!account) return;
    if (account.health === "ok") return;
    await this.deps.writeAccount({
      ...account,
      health: "ok",
      ...(account.healthDetail ? { healthDetail: undefined } : {}),
    });
  }

  /**
   * Re-probe accounts whose `health` is non-OK and whose `healthDetail.until`
   * has passed (or is absent). Used by background sweepers to recover
   * temporarily flagged accounts. We don't load access tokens here — the
   * caller probes via `refreshUsage` separately.
   */
  async reprobeFlagged(): Promise<string[]> {
    const all = this.deps.readAccounts();
    const now = Date.now();
    const ready: string[] = [];
    for (const account of Object.values(all)) {
      if (account.health === "ok") continue;
      if (account.health === "rate-limited") {
        const until = account.healthDetail?.until;
        if (typeof until === "number" && until > now) continue;
      }
      ready.push(account.id);
    }
    return ready;
  }
}

function byPriorityThenAge(
  a: LinkedAccountConfig,
  b: LinkedAccountConfig,
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const aLast = a.lastUsedAt ?? 0;
  const bLast = b.lastUsedAt ?? 0;
  return aLast - bLast; // older first
}

function byLeastUsedThenPriority(
  a: LinkedAccountConfig,
  b: LinkedAccountConfig,
): number {
  const aPct = a.usage?.sessionPct ?? 0;
  const bPct = b.usage?.sessionPct ?? 0;
  if (aPct !== bPct) return aPct - bPct;
  return byPriorityThenAge(a, b);
}

// Default deps wired against account storage plus a pool-owned metadata file.

interface PoolMetaFields {
  label: string;
  enabled: boolean;
  priority: number;
  health: LinkedAccountHealth;
  healthDetail?: LinkedAccountHealthDetail;
  usage?: LinkedAccountUsage;
}

type PoolMetaStore = Record<
  PoolProviderId,
  Record<string, PoolMetaFields>
>;

function authRoot(): string {
  return path.join(
    process.env.ELIZA_HOME || path.join(os.homedir(), ".eliza"),
    "auth",
  );
}

function metadataFile(): string {
  return path.join(authRoot(), "_pool-metadata.json");
}

function isPoolProviderId(value: string): value is PoolProviderId {
  return (
    value === "anthropic-subscription" ||
    value === "openai-codex" ||
    value === "anthropic-api" ||
    value === "openai-api"
  );
}

function readMetaStore(): PoolMetaStore {
  const file = metadataFile();
  if (!existsSync(file)) {
    return {} as PoolMetaStore;
  }
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PoolMetaStore;
    }
  } catch {
    // Corrupt file — fall through to empty store. Next write rewrites it.
  }
  return {} as PoolMetaStore;
}

function writeMetaStore(store: PoolMetaStore): void {
  const file = metadataFile();
  const dir = path.dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  renameSync(tmp, file);
}

function recordToLinked(
  record: AccountCredentialRecord,
  meta: PoolMetaFields | undefined,
  providerId: PoolProviderId,
  defaultPriority: number,
): LinkedAccountConfig {
  return {
    id: record.id,
    providerId,
    label: meta?.label ?? record.label,
    source: record.source,
    enabled: meta?.enabled ?? true,
    priority: meta?.priority ?? defaultPriority,
    createdAt: record.createdAt,
    health: meta?.health ?? "ok",
    ...(record.lastUsedAt !== undefined
      ? { lastUsedAt: record.lastUsedAt }
      : {}),
    ...(meta?.healthDetail ? { healthDetail: meta.healthDetail } : {}),
    ...(meta?.usage ? { usage: meta.usage } : {}),
    ...(record.organizationId
      ? { organizationId: record.organizationId }
      : {}),
    ...(record.userId ? { userId: record.userId } : {}),
    ...(record.email ? { email: record.email } : {}),
  };
}

function loadAllAccounts(): Record<string, LinkedAccountConfig> {
  const subscriptionProviders: SubscriptionProvider[] = [
    "anthropic-subscription",
    "openai-codex",
  ];
  const meta = readMetaStore();
  const out: Record<string, LinkedAccountConfig> = {};
  for (const provider of subscriptionProviders) {
    const records = listProviderAccounts(provider);
    let priorityCounter = 0;
    const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt);
    for (const record of sorted) {
      const providerMeta = meta[provider]?.[record.id];
      out[record.id] = recordToLinked(
        record,
        providerMeta,
        provider,
        priorityCounter,
      );
      priorityCounter += 1;
    }
  }
  return out;
}

async function persistAccount(account: LinkedAccountConfig): Promise<void> {
  if (!isPoolProviderId(account.providerId)) return;
  const store = readMetaStore();
  if (!store[account.providerId]) {
    store[account.providerId] = {};
  }
  store[account.providerId][account.id] = {
    label: account.label,
    enabled: account.enabled,
    priority: account.priority,
    health: account.health,
    ...(account.healthDetail ? { healthDetail: account.healthDetail } : {}),
    ...(account.usage ? { usage: account.usage } : {}),
  };
  writeMetaStore(store);
}

let cachedDefaultPool: AccountPool | null = null;

/**
 * Module-level singleton for the default pool wired against WS1's
 * `account-storage` and the pool-owned metadata file. Plugins / runtime
 * resolvers should import `getDefaultAccountPool()` rather than building
 * a new pool. WS3 may later swap the default deps to read/write the
 * `LinkedAccountsConfig` field directly out of `milady.json`; consumers
 * keep the same accessor.
 */
export function getDefaultAccountPool(): AccountPool {
  if (!cachedDefaultPool) {
    cachedDefaultPool = new AccountPool({
      readAccounts: () => loadAllAccounts(),
      writeAccount: persistAccount,
    });
  }
  return cachedDefaultPool;
}

/**
 * @deprecated kept for compatibility with the WS2 spec naming. Use
 * {@link getDefaultAccountPool}.
 */
export function createDefaultAccountPool(): AccountPool {
  return getDefaultAccountPool();
}

/**
 * Resets the cached singleton. Test-only.
 */
export function __resetDefaultAccountPoolForTests(): void {
  cachedDefaultPool = null;
}

export type { LinkedAccountsConfig };

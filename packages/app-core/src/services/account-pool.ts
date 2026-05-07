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
 * process restarts and is independent of WS3's eventual `eliza.json`
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
import type { AccountCredentialRecord } from "@elizaos/agent/auth/account-storage";
import {
  getAccessToken as getAccountAccessToken,
  listProviderAccounts,
} from "@elizaos/agent/auth/credentials";
import {
  ACCOUNT_CREDENTIAL_PROVIDER_IDS,
  DIRECT_ACCOUNT_PROVIDER_ENV,
  DIRECT_ACCOUNT_PROVIDER_IDS,
  type DirectAccountProvider,
  isSubscriptionProvider,
  type SubscriptionProvider,
} from "@elizaos/agent/auth/types";
import { logger } from "@elizaos/core";
import type {
  LinkedAccountConfig,
  LinkedAccountHealth,
  LinkedAccountHealthDetail,
  LinkedAccountProviderId,
  LinkedAccountsConfig,
  LinkedAccountUsage,
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

interface AffinityEntry {
  accountId: string;
  attempts: number;
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

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;
const QUOTA_AWARE_SKIP_PCT = 85;
const SESSION_AFFINITY_MAX_ATTEMPTS = 3;
const DIRECT_PROVIDER_BY_BACKEND: Readonly<
  Record<string, DirectAccountProvider>
> = {
  anthropic: "anthropic-api",
  openai: "openai-api",
  deepseek: "deepseek-api",
  zai: "zai-api",
  moonshot: "moonshot-api",
};

const OPENAI_COMPAT_BASE_BY_DIRECT_PROVIDER: Readonly<
  Partial<Record<DirectAccountProvider, string>>
> = {
  "moonshot-api": "https://api.moonshot.ai/v1",
};

const KEEP_ALIVE_INTERVAL_MS = 5 * 60_000;

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
    const explicit =
      input.accountIds && input.accountIds.length > 0
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

  // CRUD — used by accounts-routes.ts as the single source of truth for
  // LinkedAccountConfig records. Both reads and writes go through here so
  // changes from the HTTP API and from runtime mutations (markRateLimited,
  // refreshUsage, recordCall) stay consistent.

  list(providerId?: PoolProviderId): LinkedAccountConfig[] {
    const all = Object.values(this.deps.readAccounts());
    if (!providerId) return all;
    return all.filter((a) => a.providerId === providerId);
  }

  get(
    accountId: string,
    providerId?: PoolProviderId,
  ): LinkedAccountConfig | null {
    return findAccountById(this.deps.readAccounts(), accountId, providerId);
  }

  async upsert(account: LinkedAccountConfig): Promise<void> {
    await this.deps.writeAccount(account);
  }

  async deleteMetadata(
    providerId: PoolProviderId,
    accountId: string,
  ): Promise<void> {
    if (!this.deps.deleteAccount) return;
    await this.deps.deleteAccount(providerId, accountId);
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
    providerId?: PoolProviderId,
  ): Promise<void> {
    const account = findAccountById(
      this.deps.readAccounts(),
      accountId,
      providerId,
    );
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
    opts?: {
      codexAccountId?: string;
      fetch?: typeof fetch;
      providerId?: PoolProviderId;
    },
  ): Promise<void> {
    const account = findAccountById(
      this.deps.readAccounts(),
      accountId,
      opts?.providerId,
    );
    if (!account) return;

    let usage: LinkedAccountUsage;
    if (account.providerId === "anthropic-subscription") {
      usage = await pollAnthropicUsage(accessToken, opts?.fetch);
    } else if (account.providerId === "openai-codex") {
      const codexAccountId = opts?.codexAccountId ?? account.organizationId;
      if (!codexAccountId) {
        throw new Error(
          `[AccountPool] Codex usage probe needs the OpenAI account_id (account ${accountId} has no organizationId).`,
        );
      }
      usage = await pollCodexUsage(accessToken, codexAccountId, opts?.fetch);
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
    providerId?: PoolProviderId,
  ): Promise<void> {
    const account = findAccountById(
      this.deps.readAccounts(),
      accountId,
      providerId,
    );
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

  async markNeedsReauth(
    accountId: string,
    detail?: string,
    providerId?: PoolProviderId,
  ): Promise<void> {
    const account = findAccountById(
      this.deps.readAccounts(),
      accountId,
      providerId,
    );
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

  async markInvalid(
    accountId: string,
    detail?: string,
    providerId?: PoolProviderId,
  ): Promise<void> {
    const account = findAccountById(
      this.deps.readAccounts(),
      accountId,
      providerId,
    );
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

  async markHealthy(
    accountId: string,
    providerId?: PoolProviderId,
  ): Promise<void> {
    const account = findAccountById(
      this.deps.readAccounts(),
      accountId,
      providerId,
    );
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

function poolRecordKey(providerId: PoolProviderId, accountId: string): string {
  return `${providerId}:${accountId}`;
}

function findAccountById(
  all: Record<string, LinkedAccountConfig>,
  accountId: string,
  providerId?: PoolProviderId,
): LinkedAccountConfig | null {
  if (providerId) {
    return (
      all[poolRecordKey(providerId, accountId)] ??
      Object.values(all).find(
        (account) =>
          account.id === accountId && account.providerId === providerId,
      ) ??
      null
    );
  }
  const direct = all[accountId];
  if (direct) return direct;
  return Object.values(all).find((account) => account.id === accountId) ?? null;
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

type PoolMetaStore = Record<PoolProviderId, Record<string, PoolMetaFields>>;

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
    value === "openai-api" ||
    value === "deepseek-api" ||
    value === "zai-api" ||
    value === "moonshot-api"
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
    ...(record.organizationId ? { organizationId: record.organizationId } : {}),
    ...(record.userId ? { userId: record.userId } : {}),
    ...(record.email ? { email: record.email } : {}),
  };
}

function loadAllAccounts(): Record<string, LinkedAccountConfig> {
  const meta = readMetaStore();
  const out: Record<string, LinkedAccountConfig> = {};
  for (const provider of ACCOUNT_CREDENTIAL_PROVIDER_IDS) {
    const records = listProviderAccounts(provider);
    let priorityCounter = 0;
    const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt);
    for (const record of sorted) {
      const providerMeta = meta[provider]?.[record.id];
      out[poolRecordKey(provider, record.id)] = recordToLinked(
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

async function deleteAccountMeta(
  providerId: PoolProviderId,
  accountId: string,
): Promise<void> {
  const store = readMetaStore();
  const bucket = store[providerId];
  if (!bucket) return;
  if (!(accountId in bucket)) return;
  delete bucket[accountId];
  writeMetaStore(store);
}

/**
 * Symbol-keyed shim contract consumed by plugin-anthropic's
 * `credential-store.ts`. Kept narrow so the plugin doesn't have to import
 * the full pool surface (or the rest of `@elizaos/app-core`).
 */
const ANTHROPIC_POOL_SHIM_SYMBOL: unique symbol = Symbol.for(
  "eliza.account-pool.anthropic.v1",
);

interface AnthropicPoolShim {
  selectAnthropicSubscription(opts?: {
    sessionKey?: string;
    exclude?: string[];
  }): Promise<{ id: string; expiresAt: number } | null>;
  getAccessToken(
    providerId: "anthropic-subscription",
    accountId: string,
  ): Promise<string | null>;
  markInvalid(accountId: string, detail?: string): Promise<void>;
  markRateLimited(
    accountId: string,
    untilMs: number,
    detail?: string,
  ): Promise<void>;
}

/**
 * Shim used by plugin-agent-orchestrator. The orchestrator can't depend on
 * `@elizaos/app-core`, so it discovers the pool via this symbol on
 * `globalThis`. Returns the picked account + access token in one shot
 * because the orchestrator only needs to inject the env vars and forget.
 */
const ORCHESTRATOR_POOL_SHIM_SYMBOL: unique symbol = Symbol.for(
  "eliza.account-pool.orchestrator.v1",
);

interface OrchestratorPoolShim {
  pickAnthropicTokenForSpawn(opts: {
    sessionKey: string;
  }): Promise<{ accessToken: string; accountId: string } | null>;
  markRateLimited(accountId: string, untilMs: number, detail?: string): void;
  markInvalid(accountId: string, detail?: string): void;
  markNeedsReauth(accountId: string, detail?: string): void;
}

/**
 * Shim used by `applySubscriptionCredentials` in `@elizaos/agent` to pick
 * the active Codex account when applying `OPENAI_API_KEY`. Lives behind
 * a symbol so the agent package doesn't need to depend on app-core.
 */
const SUBSCRIPTION_SELECTOR_SHIM_SYMBOL: unique symbol = Symbol.for(
  "eliza.account-pool.subscription-selector.v1",
);

interface SubscriptionSelectorShim {
  /** Pick an enabled, healthy account; returns its id or null. */
  pickAccountId(providerId: SubscriptionProvider): Promise<string | null>;
}

let cachedDefaultPool: AccountPool | null = null;
let defaultSelectionConfig: AccountPoolSelectionConfig = {};

function normalizeStrategy(value: unknown): Strategy | undefined {
  return value === "priority" ||
    value === "round-robin" ||
    value === "least-used" ||
    value === "quota-aware"
    ? value
    : undefined;
}

function normalizeAccountIdsFromRoute(
  route: AccountPoolSelectionRoute | undefined,
): string[] | undefined {
  if (!route) return undefined;
  const fromList = Array.isArray(route.accountIds)
    ? route.accountIds
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter(Boolean)
    : [];
  const single =
    typeof route.accountId === "string" && route.accountId.trim()
      ? [route.accountId.trim()]
      : [];
  const ids = fromList.length > 0 ? fromList : single;
  return ids.length > 0 ? ids : undefined;
}

function routeTargetsProvider(
  route: AccountPoolSelectionRoute | undefined,
  providerId: PoolProviderId,
): boolean {
  if (!route?.backend) return false;
  const directProvider = DIRECT_PROVIDER_BY_BACKEND[route.backend];
  if (directProvider === providerId) return true;
  if (
    providerId === "anthropic-subscription" &&
    route.backend === "anthropic"
  ) {
    return true;
  }
  return providerId === "openai-codex" && route.backend === "openai";
}

function selectionForProvider(providerId: PoolProviderId): {
  strategy?: Strategy;
  accountIds?: string[];
} {
  const route = defaultSelectionConfig.serviceRouting?.llmText;
  const routeSelection = routeTargetsProvider(route, providerId)
    ? {
        strategy: normalizeStrategy(route?.strategy),
        accountIds: normalizeAccountIdsFromRoute(route),
      }
    : {};
  return {
    strategy:
      routeSelection.strategy ??
      normalizeStrategy(defaultSelectionConfig.accountStrategies?.[providerId]),
    accountIds: routeSelection.accountIds,
  };
}

export function __getDefaultAccountPoolSelectionForTests(
  providerId: PoolProviderId,
): {
  strategy?: Strategy;
  accountIds?: string[];
} {
  return selectionForProvider(providerId);
}

export function configureDefaultAccountPoolSelection(
  config: AccountPoolSelectionConfig = {},
): void {
  defaultSelectionConfig = {
    accountStrategies: config.accountStrategies ?? {},
    serviceRouting: config.serviceRouting ?? null,
  };
}

/**
 * Module-level singleton for the default pool wired against WS1's
 * `account-storage` and the pool-owned metadata file. Plugins / runtime
 * resolvers should import `getDefaultAccountPool()` rather than building
 * a new pool. WS3 may later swap the default deps to read/write the
 * `LinkedAccountsConfig` field directly out of `eliza.json`; consumers
 * keep the same accessor.
 */
export function getDefaultAccountPool(): AccountPool {
  if (!cachedDefaultPool) {
    cachedDefaultPool = new AccountPool({
      readAccounts: () => loadAllAccounts(),
      writeAccount: persistAccount,
      deleteAccount: deleteAccountMeta,
    });
    installAnthropicShim(cachedDefaultPool);
    installOrchestratorShim(cachedDefaultPool);
    installSubscriptionSelectorShim(cachedDefaultPool);
  }
  return cachedDefaultPool;
}

export async function applyAccountPoolApiCredentials(
  opts: {
    activeBackend?: string | null;
    accountStrategies?: AccountPoolSelectionConfig["accountStrategies"];
    serviceRouting?: AccountPoolSelectionConfig["serviceRouting"];
  } = {},
): Promise<void> {
  configureDefaultAccountPoolSelection({
    accountStrategies: opts.accountStrategies,
    serviceRouting: opts.serviceRouting,
  });
  const pool = getDefaultAccountPool();
  const activeProvider = opts.activeBackend
    ? DIRECT_PROVIDER_BY_BACKEND[opts.activeBackend]
    : undefined;
  let activeProviderToken: string | null = null;

  for (const providerId of DIRECT_ACCOUNT_PROVIDER_IDS) {
    const accounts = listProviderAccounts(providerId);
    if (accounts.length === 0) continue;

    const account =
      (await pool.select({
        providerId,
        sessionKey: `env:${providerId}`,
        ...selectionForProvider(providerId),
      })) ?? accounts.slice().sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!account) continue;

    const token = await getAccountAccessToken(providerId, account.id);
    if (!token) continue;

    const envKey = DIRECT_ACCOUNT_PROVIDER_ENV[providerId];
    process.env[envKey] = token;
    if (activeProvider === providerId) {
      activeProviderToken = token;
    }
    if (providerId === "zai-api") {
      process.env.Z_AI_API_KEY ??= token;
    }

    const openAiCompatibleBase =
      activeProvider === providerId
        ? OPENAI_COMPAT_BASE_BY_DIRECT_PROVIDER[providerId]
        : undefined;
    if (openAiCompatibleBase) {
      process.env.OPENAI_API_KEY = token;
      process.env.OPENAI_BASE_URL = openAiCompatibleBase;
    }
  }

  if (activeProvider && !activeProviderToken) {
    const envKey = DIRECT_ACCOUNT_PROVIDER_ENV[activeProvider];
    activeProviderToken = process.env[envKey]?.trim() || null;
    if (!activeProviderToken && activeProvider === "zai-api") {
      activeProviderToken = process.env.Z_AI_API_KEY?.trim() || null;
    }
    if (!activeProviderToken && activeProvider === "moonshot-api") {
      activeProviderToken = process.env.KIMI_API_KEY?.trim() || null;
    }
    const openAiCompatibleBase = activeProviderToken
      ? OPENAI_COMPAT_BASE_BY_DIRECT_PROVIDER[activeProvider]
      : undefined;
    const token = activeProviderToken;
    if (openAiCompatibleBase && token) {
      process.env.OPENAI_API_KEY = token;
      process.env.OPENAI_BASE_URL = openAiCompatibleBase;
    }
  }
}

export interface AccountPoolKeepAliveResult {
  checked: number;
  refreshed: number;
  failed: number;
}

export async function sweepAccountPoolKeepAlive(): Promise<AccountPoolKeepAliveResult> {
  const pool = getDefaultAccountPool();
  const result: AccountPoolKeepAliveResult = {
    checked: 0,
    refreshed: 0,
    failed: 0,
  };

  for (const providerId of ACCOUNT_CREDENTIAL_PROVIDER_IDS) {
    for (const record of listProviderAccounts(providerId)) {
      result.checked += 1;

      const token = await getAccountAccessToken(providerId, record.id);
      if (!token) {
        result.failed += 1;
        await pool.markNeedsReauth(
          record.id,
          "No valid credential available",
          providerId,
        );
        continue;
      }

      if (!isSubscriptionProvider(providerId)) {
        continue;
      }

      try {
        await pool.refreshUsage(record.id, token, {
          providerId,
          ...(record.organizationId
            ? { codexAccountId: record.organizationId }
            : {}),
        });
        result.refreshed += 1;
      } catch (err) {
        result.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        if (/401|403|invalid|unauthor/i.test(message)) {
          await pool.markNeedsReauth(record.id, message, providerId);
        } else if (/429|rate.?limit/i.test(message)) {
          await pool.markRateLimited(
            record.id,
            Date.now() + DEFAULT_RATE_LIMIT_BACKOFF_MS,
            message,
            providerId,
          );
        } else {
          await pool.markInvalid(record.id, message, providerId);
        }
      }
    }
  }

  return result;
}

let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveRunning = false;

export function startAccountPoolKeepAlive(
  intervalMs: number = KEEP_ALIVE_INTERVAL_MS,
): void {
  const disabled =
    process.env.ELIZA_ACCOUNT_POOL_KEEPALIVE?.trim().toLowerCase();
  if (
    disabled === "0" ||
    disabled === "false" ||
    disabled === "no" ||
    disabled === "off"
  ) {
    return;
  }
  if (keepAliveTimer) return;

  const run = () => {
    if (keepAliveRunning) return;
    keepAliveRunning = true;
    void sweepAccountPoolKeepAlive()
      .catch((err) => {
        logger.debug(`[AccountPool] keep-alive sweep failed: ${String(err)}`);
      })
      .finally(() => {
        keepAliveRunning = false;
      });
  };

  keepAliveTimer = setInterval(run, Math.max(60_000, intervalMs));
  keepAliveTimer.unref?.();
  run();
}

export function stopAccountPoolKeepAliveForTests(): void {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  keepAliveRunning = false;
}

/**
 * Install the `globalThis`-keyed shim that plugin-anthropic's
 * credential-store reads. Idempotent — repeated installs replace the
 * previous shim.
 */
function installAnthropicShim(pool: AccountPool): void {
  if (typeof globalThis === "undefined") return;
  const shim: AnthropicPoolShim = {
    selectAnthropicSubscription: async (opts) => {
      const account = await pool.select({
        providerId: "anthropic-subscription",
        sessionKey: opts?.sessionKey,
        exclude: opts?.exclude,
        ...selectionForProvider("anthropic-subscription"),
      });
      if (!account) return null;
      // expiresAt is sourced from the underlying credential blob via
      // `loadCredentials`; we cache it on the cached account record's
      // lastUsedAt is independent. The plugin only uses expiresAt as a
      // hint for cache TTL, so an Infinity fallback is acceptable.
      return { id: account.id, expiresAt: Number.POSITIVE_INFINITY };
    },
    getAccessToken: (providerId, accountId) =>
      getAccountAccessToken(providerId, accountId),
    markInvalid: (accountId, detail) =>
      pool.markInvalid(accountId, detail, "anthropic-subscription"),
    markRateLimited: (accountId, untilMs, detail) =>
      pool.markRateLimited(
        accountId,
        untilMs,
        detail,
        "anthropic-subscription",
      ),
  };
  (globalThis as Record<symbol, unknown>)[ANTHROPIC_POOL_SHIM_SYMBOL] = shim;
}

function installOrchestratorShim(pool: AccountPool): void {
  if (typeof globalThis === "undefined") return;
  const shim: OrchestratorPoolShim = {
    pickAnthropicTokenForSpawn: async ({ sessionKey }) => {
      const account = await pool.select({
        providerId: "anthropic-subscription",
        sessionKey,
        ...selectionForProvider("anthropic-subscription"),
      });
      if (!account) return null;
      const token = await getAccountAccessToken(
        "anthropic-subscription",
        account.id,
      );
      if (!token) return null;
      return { accessToken: token, accountId: account.id };
    },
    markRateLimited: (accountId, untilMs, detail) => {
      void pool.markRateLimited(
        accountId,
        untilMs,
        detail,
        "anthropic-subscription",
      );
    },
    markInvalid: (accountId, detail) => {
      void pool.markInvalid(accountId, detail, "anthropic-subscription");
    },
    markNeedsReauth: (accountId, detail) => {
      void pool.markNeedsReauth(accountId, detail, "anthropic-subscription");
    },
  };
  (globalThis as Record<symbol, unknown>)[ORCHESTRATOR_POOL_SHIM_SYMBOL] = shim;
}

function installSubscriptionSelectorShim(pool: AccountPool): void {
  if (typeof globalThis === "undefined") return;
  const shim: SubscriptionSelectorShim = {
    pickAccountId: async (providerId) => {
      const account = await pool.select({
        providerId,
        ...selectionForProvider(providerId),
      });
      return account?.id ?? null;
    },
  };
  (globalThis as Record<symbol, unknown>)[SUBSCRIPTION_SELECTOR_SHIM_SYMBOL] =
    shim;
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
  stopAccountPoolKeepAliveForTests();
  cachedDefaultPool = null;
}

export type { LinkedAccountsConfig };

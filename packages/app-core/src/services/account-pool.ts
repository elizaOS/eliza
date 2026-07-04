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
 * layer; the OAuth blob lives under the active state-dir auth directory.
 *
 * Persistence: the pool layers rich metadata (priority, enabled, health,
 * usage) on top of the credential records from `@elizaos/agent`. The
 * metadata is written to `<stateDir>/auth/_pool-metadata.json` atomically
 * so it survives process restarts.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { AccountCredentialRecord } from "@elizaos/auth/account-storage";
import {
  getAccessToken as getAccountAccessToken,
  listProviderAccounts,
} from "@elizaos/auth/credentials";
import {
  ACCOUNT_CREDENTIAL_PROVIDER_IDS,
  DIRECT_ACCOUNT_PROVIDER_ENV,
  DIRECT_ACCOUNT_PROVIDER_IDS,
  type DirectAccountProvider,
  isSubscriptionProvider,
  type SubscriptionProvider,
} from "@elizaos/auth/types";
import {
  type AnthropicAccountPoolBridge,
  logger,
  resolveStateDir,
  setAnthropicAccountPoolBridge,
} from "@elizaos/core";
import type {
  LinkedAccountConfig,
  LinkedAccountHealth,
  LinkedAccountHealthDetail,
  LinkedAccountProviderId,
  LinkedAccountsConfig,
  LinkedAccountUsage,
} from "@elizaos/shared/contracts/service-routing";
import { isLinkedAccountProviderId } from "@elizaos/shared/contracts/service-routing";
import {
  pollAnthropicUsage,
  pollCodexUsage,
  recordCall as recordUsageEntry,
} from "./account-usage.js";
import {
  adoptRotatedCodexTokens,
  installCodingAgentSelectorBridge,
} from "./coding-account-bridge.js";

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

function accountSessionPct(account: LinkedAccountConfig): number {
  return typeof account.usage?.sessionPct === "number"
    ? account.usage.sessionPct
    : 0;
}

function accountLastUsedAt(account: LinkedAccountConfig): number {
  return typeof account.lastUsedAt === "number" ? account.lastUsedAt : 0;
}

// affinity is keyed by sessionKey, which is per-conversation/per-request, so the
// map grows one entry per distinct session over the process lifetime. Cap it
// (FIFO by Map insertion order) — an evicted session simply re-selects on its
// next call, which is the same behavior as a cold session.
const MAX_AFFINITY_ENTRIES = 10_000;

export class AccountPool {
  private readonly deps: AccountPoolDeps;
  private readonly affinity = new Map<string, AffinityEntry>();
  private readonly roundRobinCursor = new Map<PoolProviderId, number>();
  // Burst-spread for least-used: `usage.sessionPct` is only refreshed every few
  // minutes, so a burst of fresh spawns inside one poll window would otherwise
  // all stack on the single lowest-sessionPct account. Stamping each pick lets
  // the tiebreak rotate across equally-/un-probed accounts until real usage
  // diverges. Monotonic + epoch-aligned so it composes with `lastUsedAt`.
  private readonly recentlySelectedAt = new Map<string, number>();
  private selectionClock = 0;

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
    this.stampSelection(picked.id);

    if (input.sessionKey) {
      this.affinity.set(input.sessionKey, {
        accountId: picked.id,
        attempts: 1,
      });
      while (this.affinity.size > MAX_AFFINITY_ENTRIES) {
        const oldest = this.affinity.keys().next().value;
        if (oldest === undefined) break;
        this.affinity.delete(oldest);
      }
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
      return isAccountSelectableNow(account, now);
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
        // The ring MUST have a stable order: byPriorityThenAge tiebreaks on
        // lastUsedAt, which recordCall bumps between selects, so the ring
        // would reshuffle under the cursor and serve the same account
        // back-to-back (a,a,b,b,…) in the normal select→record→select flow.
        const sorted = [...eligible].sort(byPriorityThenStableIdentity);
        const cursor = (this.roundRobinCursor.get(providerId) ?? -1) + 1;
        const index = cursor % sorted.length;
        this.roundRobinCursor.set(providerId, index);
        return sorted[index] ?? null;
      }
      case "least-used": {
        return (
          [...eligible].sort((a, b) => this.byLeastUsedEffective(a, b))[0] ??
          null
        );
      }
      case "quota-aware": {
        const underQuota = eligible.filter(
          (a) => accountSessionPct(a) < QUOTA_AWARE_SKIP_PCT,
        );
        const pool = underQuota.length > 0 ? underQuota : eligible;
        return [...pool].sort(byPriorityThenAge)[0] ?? null;
      }
      default:
        return [...eligible].sort(byPriorityThenAge)[0] ?? null;
    }
  }

  /** Record that `accountId` was just selected, with a strictly-increasing,
   * epoch-aligned stamp so a same-millisecond burst still rotates. */
  private stampSelection(accountId: string): void {
    this.selectionClock = Math.max(Date.now(), this.selectionClock + 1);
    this.recentlySelectedAt.set(accountId, this.selectionClock);
    while (this.recentlySelectedAt.size > MAX_AFFINITY_ENTRIES) {
      const oldest = this.recentlySelectedAt.keys().next().value;
      if (oldest === undefined) break;
      this.recentlySelectedAt.delete(oldest);
    }
  }

  /** Most recent of the persisted `lastUsedAt` and the in-memory selection
   * stamp — so a just-picked account sorts as "more recently used". */
  private effectiveLastUsed(account: LinkedAccountConfig): number {
    const recentSelection = this.recentlySelectedAt.get(account.id);
    return Math.max(
      accountLastUsedAt(account),
      recentSelection === undefined ? 0 : recentSelection,
    );
  }

  /** least-used comparator: spread load first by reported usage, then by
   * recency-of-use (persisted + in-flight selection). Recency is ranked ABOVE
   * `priority` here because least-used is a load-spreading strategy and the
   * default `priority` is just creation order — honoring it would pin every
   * equal-usage pick to the oldest account (the burst herd). `priority` only
   * breaks a recency tie. */
  private byLeastUsedEffective(
    a: LinkedAccountConfig,
    b: LinkedAccountConfig,
  ): number {
    const aPct = accountSessionPct(a);
    const bPct = accountSessionPct(b);
    if (aPct !== bPct) return aPct - bPct;
    const aUsed = this.effectiveLastUsed(a);
    const bUsed = this.effectiveLastUsed(b);
    if (aUsed !== bUsed) return aUsed - bUsed;
    return a.priority - b.priority;
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
    opts?: { providerId?: PoolProviderId },
  ): Promise<void> {
    const account = findAccountById(
      this.deps.readAccounts(),
      accountId,
      opts?.providerId,
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
    opts?: { providerId?: PoolProviderId },
  ): Promise<void> {
    const account = findAccountById(
      this.deps.readAccounts(),
      accountId,
      opts?.providerId,
    );
    if (!account) return;
    // Callers pass a heuristic cool-off (60s probe default / 15min session
    // default), but the provider's own usage window is authoritative when we
    // have it: Anthropic and Codex both report the window's reset timestamp
    // via the usage probes. Using it re-admits the account exactly when the
    // limit lifts — a shorter heuristic ping-pongs spawns onto a still-limited
    // account (a ~5h window retried every 60s), a longer one strands a
    // recovered account out of rotation.
    const providerResetMs = account.usage?.resetsAt;
    const heuristicUntil =
      Number.isFinite(untilMs) && untilMs > Date.now()
        ? untilMs
        : Date.now() + DEFAULT_RATE_LIMIT_BACKOFF_MS;
    const healthDetail: LinkedAccountHealthDetail = {
      until:
        typeof providerResetMs === "number" && providerResetMs > Date.now()
          ? providerResetMs
          : heuristicUntil,
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
    opts?: { providerId?: PoolProviderId },
  ): Promise<void> {
    const account = findAccountById(
      this.deps.readAccounts(),
      accountId,
      opts?.providerId,
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
    opts?: { providerId?: PoolProviderId },
  ): Promise<void> {
    const account = findAccountById(
      this.deps.readAccounts(),
      accountId,
      opts?.providerId,
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
    opts?: { providerId?: PoolProviderId },
  ): Promise<void> {
    const account = findAccountById(
      this.deps.readAccounts(),
      accountId,
      opts?.providerId,
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

/**
 * Health half of the eligibility gate, shared with the coding-agent bridge's
 * `describe()` so availability reporting can never disagree with what
 * `select()` would actually serve: `ok` is selectable, and a rate-limited
 * account is selectable again once its `healthDetail.until` reset has elapsed
 * (`invalid` / `needs-reauth` never re-admit on their own). Counting only
 * `health === "ok"` here used to report `healthy: 0` for a pool whose
 * rate-limit window had already elapsed — making the orchestrator's failover
 * gate refuse a respawn that `select()` would have served.
 */
export function isAccountSelectableNow(
  account: LinkedAccountConfig,
  now: number = Date.now(),
): boolean {
  if (account.health === "ok") return true;
  return (
    account.health === "rate-limited" &&
    typeof account.healthDetail?.until === "number" &&
    account.healthDetail.until < now
  );
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
    const scoped = all[poolRecordKey(providerId, accountId)];
    if (scoped) return scoped;
    return (
      Object.values(all).find(
        (account) =>
          account.id === accountId && account.providerId === providerId,
      ) ?? null
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
  const aLast = accountLastUsedAt(a);
  const bLast = accountLastUsedAt(b);
  return aLast - bLast; // older first
}

/** Mutation-free ordering for the round-robin ring: identity fields only
 * (priority, createdAt, id), so the cursor walks the same sequence no matter
 * how usage recording mutates `lastUsedAt` between selects. */
function byPriorityThenStableIdentity(
  a: LinkedAccountConfig,
  b: LinkedAccountConfig,
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function _byLeastUsedThenPriority(
  a: LinkedAccountConfig,
  b: LinkedAccountConfig,
): number {
  const aPct = accountSessionPct(a);
  const bPct = accountSessionPct(b);
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
  /** Persisted so recordCall's "last used" survives restarts and feeds both the
   * dashboard and the least-used age tiebreak (the credential record's own
   * lastUsedAt is only bumped by touchAccount, not by usage recording). */
  lastUsedAt?: number;
}

type PoolMetaStore = Record<PoolProviderId, Record<string, PoolMetaFields>>;

function authRoot(): string {
  return path.join(process.env.ELIZA_HOME || resolveStateDir(), "auth");
}

function metadataFile(): string {
  return path.join(authRoot(), "_pool-metadata.json");
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
    // Prefer the pool-meta lastUsedAt (bumped by recordCall) over the credential
    // record's (bumped only by touchAccount); fall back to the record's.
    ...((meta?.lastUsedAt ?? record.lastUsedAt) !== undefined
      ? { lastUsedAt: meta?.lastUsedAt ?? record.lastUsedAt }
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
  if (!isLinkedAccountProviderId(account.providerId)) return;
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
    ...(account.lastUsedAt !== undefined
      ? { lastUsedAt: account.lastUsedAt }
      : {}),
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

/**
 * Live read of the configured per-provider selection (the app's
 * `config.accountStrategies` picker plus any llmText service-routing pin).
 * Every account-selecting bridge resolves through this so the picker steers
 * all of them — including the coding-agent bridge.
 */
export function selectionForProvider(providerId: PoolProviderId): {
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

export function configureDefaultAccountPoolSelection(
  config: AccountPoolSelectionConfig = {},
): void {
  defaultSelectionConfig = {
    accountStrategies: config.accountStrategies ?? {},
    serviceRouting: config.serviceRouting ?? null,
  };
}

/**
 * Module-level singleton for the default pool wired against `@elizaos/agent`'s
 * account-storage and the pool-owned metadata file. Plugins and runtime
 * resolvers should import `getDefaultAccountPool()` rather than constructing
 * a new pool directly.
 */
export function getDefaultAccountPool(): AccountPool {
  if (!cachedDefaultPool) {
    cachedDefaultPool = new AccountPool({
      readAccounts: () => loadAllAccounts(),
      writeAccount: persistAccount,
      deleteAccount: deleteAccountMeta,
    });
    installAnthropicBridge(cachedDefaultPool);
    installCodingAgentSelectorBridge(cachedDefaultPool);
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

      // A Codex CLI may have rotated the one-time refresh token inside its
      // per-account CODEX_HOME mid-session; adopt it BEFORE resolving, or the
      // refresh below burns on the consumed token and this sweep marks a
      // perfectly recoverable account needs-reauth.
      if (providerId === "openai-codex") {
        await adoptRotatedCodexTokens(record.id).catch(() => false);
      }
      const token = await getAccountAccessToken(providerId, record.id);
      if (!token) {
        result.failed += 1;
        await pool.markNeedsReauth(record.id, "No valid credential available", {
          providerId,
        });
        continue;
      }

      if (!isSubscriptionProvider(providerId)) {
        // Direct-API providers have no usage probe, but a successful token
        // resolve proves the credential works — clear any stale needs-reauth /
        // invalid flag so a transient earlier failure doesn't strand the account
        // out of rotation (filterEligible only re-admits OK + reset rate-limits,
        // and refreshUsage — the only other path to `ok` — skips direct APIs).
        await pool.markHealthy(record.id, { providerId });
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
          await pool.markNeedsReauth(record.id, message, { providerId });
        } else if (/429|rate.?limit/i.test(message)) {
          await pool.markRateLimited(
            record.id,
            Date.now() + DEFAULT_RATE_LIMIT_BACKOFF_MS,
            message,
            { providerId },
          );
        } else {
          await pool.markInvalid(record.id, message, { providerId });
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
  keepAliveTimer.unref();
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
 * Install the `globalThis`-keyed bridge that plugin-anthropic's
 * credential-store reads. Idempotent — repeated installs replace the
 * previous bridge.
 */
function installAnthropicBridge(pool: AccountPool): void {
  const bridge: AnthropicAccountPoolBridge = {
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
      pool.markInvalid(accountId, detail, {
        providerId: "anthropic-subscription",
      }),
    markRateLimited: (accountId, untilMs, detail) =>
      pool.markRateLimited(accountId, untilMs, detail, {
        providerId: "anthropic-subscription",
      }),
  };
  setAnthropicAccountPoolBridge(bridge);
}

/**
 * Resets the cached singleton. Test-only.
 */
export function __resetDefaultAccountPoolForTests(): void {
  stopAccountPoolKeepAliveForTests();
  cachedDefaultPool = null;
}

export type { LinkedAccountsConfig };

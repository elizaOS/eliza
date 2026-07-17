/**
 * Multi-account selection brain.
 *
 * Owns the runtime decision "which `LinkedAccountConfig` should serve this
 * request?" given a strategy (priority / round-robin / least-used /
 * quota-aware / drain-soonest-reset), session affinity, and per-account health
 * state.
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
import { fetchAnthropicOAuthProfile } from "@elizaos/auth/oauth-flow";
import {
  ACCOUNT_CREDENTIAL_PROVIDER_IDS,
  DIRECT_ACCOUNT_PROVIDER_ENV,
  DIRECT_ACCOUNT_PROVIDER_IDS,
  type DirectAccountProvider,
  isSubscriptionProvider,
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
  | "quota-aware"
  | "reset-soonest"
  | "drain-soonest-reset";

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
  /** Requested model/display name for provider-specific weekly buckets. */
  model?: string;
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
const USAGE_PRIMING_DEBOUNCE_MS = 6 * 60 * 60_000;
const USAGE_PRIMING_RETRY_DELAY_MS = 30_000;
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_USAGE_PRIMING_MODEL = "claude-haiku-4-5-20251001";
const SUBSCRIPTION_END_BOOST_WINDOW_MS = 48 * 60 * 60 * 1000;
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

function accountWeeklyPct(account: LinkedAccountConfig): number {
  return typeof account.usage?.weeklyPct === "number"
    ? account.usage.weeklyPct
    : accountSessionPct(account);
}

function normalizeModelKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function modelKeysMatch(requested: string, bucket: string): boolean {
  return (
    requested === bucket ||
    (bucket.length >= 4 && requested.includes(bucket)) ||
    (requested.length >= 4 && bucket.includes(requested))
  );
}

function accountWeeklyBucket(
  account: LinkedAccountConfig,
  requestedModel?: string,
): { pct: number; resetsAt?: number } {
  const key = requestedModel ? normalizeModelKey(requestedModel) : "";
  const buckets = account.usage?.weeklyModelBuckets;
  if (key && buckets) {
    for (const [name, bucket] of Object.entries(buckets)) {
      if (modelKeysMatch(key, normalizeModelKey(name))) return bucket;
    }
  }
  return {
    pct: accountWeeklyPct(account),
    ...(account.usage?.resetsAt !== undefined
      ? { resetsAt: account.usage.resetsAt }
      : {}),
  };
}

function accountLastUsedAt(account: LinkedAccountConfig): number {
  return typeof account.lastUsedAt === "number" ? account.lastUsedAt : 0;
}

/**
 * The instant an account's weekly budget refunds. Prefers the usage
 * snapshot's `resetsAt`; falls back to a live rate-limit `until`. Undefined
 * when the provider hasn't reported a reset window yet.
 */
function accountResetAt(account: LinkedAccountConfig): number | undefined {
  return account.usage?.resetsAt;
}

/**
 * `reset-soonest` comparator. Prefer the account whose weekly reset arrives
 * SOONEST: its budget refunds first, so spending it now is the cheapest.
 * Accounts with a known reset instant sort ahead of unknowns; ties and
 * all-unknown pools fall back to least-recently-used (held-in-reserve
 * heuristic), then priority for a fully stable order.
 */
function bySoonestReset(
  a: LinkedAccountConfig,
  b: LinkedAccountConfig,
): number {
  const ar = accountResetAt(a);
  const br = accountResetAt(b);
  if (ar != null && br != null) {
    if (ar !== br) return ar - br;
  } else if (ar != null) {
    return -1;
  } else if (br != null) {
    return 1;
  }
  const aUsed = accountLastUsedAt(a);
  const bUsed = accountLastUsedAt(b);
  if (aUsed !== bUsed) return aUsed - bUsed;
  return a.priority - b.priority;
}

function subscriptionEndBoost(
  account: LinkedAccountConfig,
  now: number,
): number {
  if (
    typeof account.subscriptionEndsAt !== "number" ||
    account.subscriptionEndsAt <= now
  ) {
    return Number.MAX_SAFE_INTEGER;
  }
  const remaining = account.subscriptionEndsAt - now;
  return remaining <= SUBSCRIPTION_END_BOOST_WINDOW_MS
    ? remaining
    : Number.MAX_SAFE_INTEGER;
}

function isAccountExpired(
  account: LinkedAccountConfig,
  now: number = Date.now(),
): boolean {
  return (
    typeof account.subscriptionEndsAt === "number" &&
    account.subscriptionEndsAt <= now
  );
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
    await this.markExpiredAccounts(input.providerId, all);
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
    const picked = this.applyStrategy(strategy, eligible, input.providerId, {
      model: input.model,
    });
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

  /**
   * Non-mutating dry-run of selection for the accounts API / settings UI:
   * "which account would we serve next for this provider, and why?" Uses the
   * SAME eligibility + strategy ordering as {@link select} but never stamps a
   * selection or touches affinity, so polling it from the UI has no runtime
   * side effects. Ignores session affinity (that's per-request state the UI
   * can't meaningfully reflect).
   */
  selectionState(
    providerId: PoolProviderId,
    strategy: Strategy = "priority",
    opts?: { model?: string; accountIds?: string[] },
  ): { activeAccountId: string | null; reason: string | null } {
    const all = this.deps.readAccounts();
    const eligible = this.filterEligible(all, {
      providerId,
      accountIds: opts?.accountIds,
    });
    if (eligible.length === 0) return { activeAccountId: null, reason: null };
    if (eligible.length === 1) {
      return {
        activeAccountId: eligible[0]?.id ?? null,
        reason: "only-eligible",
      };
    }
    const picked = this.applyStrategy(strategy, eligible, providerId, opts);
    if (!picked) return { activeAccountId: null, reason: null };
    let reason: string = strategy;
    if (strategy === "reset-soonest") {
      // Distinguish a real reset-time pick from the least-recently-used
      // fallback so the UI copy stays honest.
      reason = eligible.some((a) => accountResetAt(a) != null)
        ? "reset-soonest"
        : "least-recently-throttled";
    } else if (strategy === "drain-soonest-reset") {
      reason = "drain-soonest-reset";
    }
    return { activeAccountId: picked.id, reason };
  }

  async sweepExpired(providerId?: PoolProviderId): Promise<number> {
    const all = this.deps.readAccounts();
    return this.markExpiredAccounts(providerId, all);
  }

  private async markExpiredAccounts(
    providerId: PoolProviderId | undefined,
    all: Record<string, LinkedAccountConfig>,
  ): Promise<number> {
    const now = Date.now();
    let changed = 0;
    for (const account of Object.values(all)) {
      if (providerId && account.providerId !== providerId) continue;
      if (
        typeof account.subscriptionEndsAt !== "number" ||
        account.subscriptionEndsAt > now ||
        account.health === "expired"
      ) {
        continue;
      }
      changed += 1;
      logger.warn(
        `[AccountPool] account expired providerId=${account.providerId} accountId=${account.id} subscriptionEndsAt=${account.subscriptionEndsAt}`,
      );
      await this.deps.writeAccount({
        ...account,
        health: "expired",
        healthDetail: { lastChecked: now },
      });
    }
    return changed;
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
    opts: { model?: string } = {},
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
      case "reset-soonest": {
        // Among accounts still under quota, serve the one whose weekly budget
        // refunds soonest. Accounts that just reset (far-off resetsAt) are
        // naturally held in reserve because they sort last.
        const underQuota = eligible.filter(
          (a) => accountSessionPct(a) < QUOTA_AWARE_SKIP_PCT,
        );
        const pool = underQuota.length > 0 ? underQuota : eligible;
        return [...pool].sort(bySoonestReset)[0] ?? null;
      }
      case "drain-soonest-reset": {
        // A weekly window is the scarce budget, but a currently exhausted
        // session cannot serve traffic. Cool it out without changing the
        // relative weekly drain order used when it becomes eligible again.
        const underSessionCap = eligible.filter(
          (a) => accountSessionPct(a) < QUOTA_AWARE_SKIP_PCT,
        );
        const pool = underSessionCap.length > 0 ? underSessionCap : eligible;
        return (
          [...pool].sort((a, b) => byDrainSoonestReset(a, b, opts.model))[0] ??
          null
        );
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
    const prior = this.get(account.id, account.providerId);
    await this.deps.writeAccount({
      ...account,
      prioritySource:
        account.prioritySource ?? prior?.prioritySource ?? "generated",
    });
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
    if (isAccountExpired(account)) {
      await this.markExpiredAccounts(account.providerId, {
        [poolRecordKey(account.providerId, account.id)]: account,
      });
      return;
    }

    let usage: LinkedAccountUsage;
    // Anthropic's OAuth token is opaque (no OIDC claims), so accounts linked
    // before the OAuth flow started persisting the profile email — or imported
    // from a CLI login — have no identity to display. Backfill it here from the
    // same profile endpoint the link flow uses.
    let email: string | undefined;
    if (account.providerId === "anthropic-subscription") {
      usage = await pollAnthropicUsage(accessToken, opts?.fetch);
      if (!account.email) {
        try {
          email = (await fetchAnthropicOAuthProfile(accessToken, opts?.fetch))
            .email;
        } catch (err) {
          // error-policy:J7 diagnostics-must-not-kill-the-loop — the identity
          // backfill is enrichment on top of the usage refresh. A profile
          // failure is REPORTED here (typed ElizaError from the profile
          // boundary, logged with the account id) and the email stays absent —
          // never fabricated as a healthy empty identity — while the
          // successfully fetched usage snapshot below is still persisted.
          logger.warn(
            `[AccountPool] Anthropic profile backfill failed for account ${accountId}: ${String(err)}`,
          );
        }
      }
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
      ...(email ? { email } : {}),
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
    // Provider-authoritative cooldown, per provider semantics of
    // `usage.resetsAt` (see LinkedAccountUsage contract):
    //  - Codex persists its PRIMARY FIVE-HOUR window reset there, which is
    //    exactly the 429 cooldown clock. Using it re-admits the account the
    //    moment the limit lifts; a 60s caller heuristic would ping-pong spawns
    //    onto a still-limited ~5h window every minute (the documented Codex
    //    429 regression).
    //  - Anthropic persists the SEVEN-DAY weekly reset there for drain
    //    ordering. Using it as a 429 cooldown would strand a session-limited
    //    account for up to a week, so Anthropic keeps the caller heuristic
    //    (60s probe default / provider retry-after when the caller has one).
    const providerResetMs =
      account.providerId === "openai-codex"
        ? account.usage?.resetsAt
        : undefined;
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
    if (isAccountExpired(account)) {
      await this.markExpiredAccounts(account.providerId, {
        [poolRecordKey(account.providerId, account.id)]: account,
      });
      return;
    }
    // Repeated probes may report the same state; log only the transition while
    // still persisting the newest diagnostic detail on every call.
    if (account.health !== "needs-reauth") {
      logger.warn(
        `[account-pool] ${account.providerId} account "${account.label ?? account.id}" (${account.id}) → needs-reauth: ${detail ?? "no detail provided"}`,
      );
    }
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
    if (isAccountExpired(account)) {
      await this.markExpiredAccounts(account.providerId, {
        [poolRecordKey(account.providerId, account.id)]: account,
      });
      return;
    }
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
    if (isAccountExpired(account)) {
      await this.markExpiredAccounts(account.providerId, {
        [poolRecordKey(account.providerId, account.id)]: account,
      });
      return;
    }
    if (account.health === "ok") return;
    await this.deps.writeAccount({
      ...account,
      health: "ok",
      ...(account.healthDetail ? { healthDetail: undefined } : {}),
    });
  }

  async markUsagePrimed(
    accountId: string,
    lastPrimedAt: number = Date.now(),
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
      lastPrimedAt,
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
  if (isAccountExpired(account, now)) return false;
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

function byExplicitPriority(
  a: LinkedAccountConfig,
  b: LinkedAccountConfig,
): number {
  const aExplicit = a.prioritySource === "explicit";
  const bExplicit = b.prioritySource === "explicit";
  if (aExplicit && bExplicit && a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  if (aExplicit !== bExplicit) return aExplicit ? -1 : 1;
  return 0;
}

function byDrainSoonestReset(
  a: LinkedAccountConfig,
  b: LinkedAccountConfig,
  requestedModel?: string,
): number {
  const explicit = byExplicitPriority(a, b);
  if (explicit !== 0) return explicit;
  const aBucket = accountWeeklyBucket(a, requestedModel);
  const bBucket = accountWeeklyBucket(b, requestedModel);
  if (aBucket.resetsAt != null && bBucket.resetsAt != null) {
    if (aBucket.resetsAt !== bBucket.resetsAt) {
      return aBucket.resetsAt - bBucket.resetsAt;
    }
  } else if (aBucket.resetsAt != null) {
    return -1;
  } else if (bBucket.resetsAt != null) {
    return 1;
  }
  if (aBucket.pct !== bBucket.pct) return aBucket.pct - bBucket.pct;
  const now = Date.now();
  const aBoost = subscriptionEndBoost(a, now);
  const bBoost = subscriptionEndBoost(b, now);
  if (aBoost !== bBoost) return aBoost - bBoost;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
  prioritySource?: "explicit" | "generated";
  health: LinkedAccountHealth;
  healthDetail?: LinkedAccountHealthDetail;
  usage?: LinkedAccountUsage;
  subscriptionEndsAt?: number;
  /** Persisted so recordCall's "last used" survives restarts and feeds both the
   * dashboard and the least-used age tiebreak (the credential record's own
   * lastUsedAt is only bumped by touchAccount, not by usage recording). */
  lastUsedAt?: number;
  /** Last low-cost provider probe attempt used to wake delayed usage visibility
   * for subscription accounts whose reset window is missing or due. */
  lastPrimedAt?: number;
  /** Account email. New OAuth links persist it on the credential record, but
   * Anthropic's token is opaque, so accounts linked earlier (or imported from a
   * CLI login) get it backfilled by refreshUsage's profile probe and persisted
   * HERE — the credential file is never rewritten for display metadata. */
  email?: string;
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
    // Legacy metadata persisted creation-order priorities for every account.
    // Treat an unchanged creation-order value as generated, while preserving a
    // hand-tuned legacy value as an explicit override.
    prioritySource:
      meta?.prioritySource ??
      (typeof meta?.priority === "number" && meta.priority !== defaultPriority
        ? "explicit"
        : "generated"),
    createdAt: record.createdAt,
    health: meta?.health ?? "ok",
    // Prefer the pool-meta lastUsedAt (bumped by recordCall) over the credential
    // record's (bumped only by touchAccount); fall back to the record's.
    ...((meta?.lastUsedAt ?? record.lastUsedAt) !== undefined
      ? { lastUsedAt: meta?.lastUsedAt ?? record.lastUsedAt }
      : {}),
    ...(meta?.lastPrimedAt !== undefined
      ? { lastPrimedAt: meta.lastPrimedAt }
      : {}),
    ...(meta?.healthDetail ? { healthDetail: meta.healthDetail } : {}),
    ...(meta?.usage ? { usage: meta.usage } : {}),
    ...(typeof meta?.subscriptionEndsAt === "number"
      ? { subscriptionEndsAt: meta.subscriptionEndsAt }
      : {}),
    ...(record.organizationId ? { organizationId: record.organizationId } : {}),
    ...(record.userId ? { userId: record.userId } : {}),
    ...(() => {
      // Show WHO an account is: prefer the credential record's email (new OAuth
      // links persist it), then the pool-meta backfill (refreshUsage profile
      // probe for older Anthropic links), then derive it from the id_token's
      // OIDC `email` claim (Codex CLI imports carry an id_token; providers
      // without one simply have no email to show).
      const email =
        record.email ??
        meta?.email ??
        emailFromIdToken(record.credentials.idToken);
      return email ? { email } : {};
    })(),
  };
}

/** The OIDC `email` claim from a JWT id_token, or undefined. */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const segments = idToken.split(".");
    const encodedPayload = segments.length === 3 ? segments[1] : undefined;
    if (!encodedPayload) return undefined;
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as { email?: unknown };
    return typeof payload.email === "string" && payload.email.includes("@")
      ? payload.email
      : undefined;
  } catch {
    // error-policy:J3 untrusted id_token payload — undecodable ⇒ no email.
    return undefined;
  }
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
    prioritySource: account.prioritySource ?? "generated",
    health: account.health,
    ...(account.healthDetail ? { healthDetail: account.healthDetail } : {}),
    ...(account.usage ? { usage: account.usage } : {}),
    ...(typeof account.subscriptionEndsAt === "number"
      ? { subscriptionEndsAt: account.subscriptionEndsAt }
      : {}),
    ...(account.lastUsedAt !== undefined
      ? { lastUsedAt: account.lastUsedAt }
      : {}),
    ...(account.lastPrimedAt !== undefined
      ? { lastPrimedAt: account.lastPrimedAt }
      : {}),
    ...(account.email ? { email: account.email } : {}),
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
    value === "quota-aware" ||
    value === "reset-soonest" ||
    value === "drain-soonest-reset"
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
      normalizeStrategy(
        defaultSelectionConfig.accountStrategies?.[providerId],
      ) ??
      (providerId === "anthropic-subscription"
        ? "drain-soonest-reset"
        : undefined),
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

export interface AccountPoolKeepAliveDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  usagePrimingRetryDelayMs?: number;
}

function accountPoolUsagePrimingEnabled(): boolean {
  const value =
    process.env.ELIZA_ACCOUNT_POOL_USAGE_PRIMING?.trim().toLowerCase();
  return (
    value !== "0" && value !== "false" && value !== "no" && value !== "off"
  );
}

function accountNeedsUsagePriming(
  account: LinkedAccountConfig | null,
  now: number,
): boolean {
  if (!account?.enabled) return false;
  const resetsAt = account.usage?.resetsAt;
  const lastPrimedAt = account.lastPrimedAt;
  if (typeof resetsAt === "number" && resetsAt <= now) {
    // One attempt per crossed reset boundary, even inside the normal debounce.
    return typeof lastPrimedAt !== "number" || lastPrimedAt < resetsAt;
  }
  if (typeof resetsAt === "number") return false;
  return (
    typeof lastPrimedAt !== "number" ||
    lastPrimedAt + USAGE_PRIMING_DEBOUNCE_MS <= now
  );
}

async function probeAnthropicUsagePriming(
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_USAGE_PRIMING_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Anthropic usage priming probe failed: HTTP ${response.status}`,
    );
  }
  await response.body?.cancel();
}

async function primeAnthropicUsageThenRefresh(
  pool: AccountPool,
  record: AccountCredentialRecord,
  token: string,
  deps: Required<AccountPoolKeepAliveDeps>,
): Promise<void> {
  // Persist the attempt before probing so a soft provider failure cannot cause
  // a probe storm on every keep-alive sweep.
  await pool.markUsagePrimed(record.id, deps.now(), {
    providerId: "anthropic-subscription",
  });
  try {
    await probeAnthropicUsagePriming(token, deps.fetch);
  } catch {
    // error-policy:J7 diagnostics-must-not-kill-the-loop — priming is an
    // observability wake-up call, not credential proof. Keep health untouched
    // and never include provider error text because OAuth failures may echo
    // request metadata.
    logger.warn(
      `[AccountPool] Anthropic usage priming failed for account ${record.id}; usage refresh will continue.`,
    );
  }

  await pool.refreshUsage(record.id, token, {
    providerId: "anthropic-subscription",
    fetch: deps.fetch,
  });
  const refreshedReset = pool.get(record.id, "anthropic-subscription")?.usage
    ?.resetsAt;
  if (refreshedReset !== undefined && refreshedReset > deps.now()) {
    return;
  }
  await deps.sleep(deps.usagePrimingRetryDelayMs);
  await pool.refreshUsage(record.id, token, {
    providerId: "anthropic-subscription",
    fetch: deps.fetch,
  });
}

function resolveKeepAliveDeps(
  deps: AccountPoolKeepAliveDeps = {},
): Required<AccountPoolKeepAliveDeps> {
  const envDelay = Number.parseInt(
    process.env.ELIZA_ACCOUNT_POOL_USAGE_PRIMING_RETRY_DELAY_MS ?? "",
    10,
  );
  const usagePrimingRetryDelayMs =
    deps.usagePrimingRetryDelayMs ??
    (Number.isFinite(envDelay) && envDelay >= 0
      ? envDelay
      : USAGE_PRIMING_RETRY_DELAY_MS);
  return {
    fetch: deps.fetch ?? fetch,
    sleep:
      deps.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? (() => Date.now()),
    usagePrimingRetryDelayMs,
  };
}

export async function sweepAccountPoolKeepAlive(
  deps: AccountPoolKeepAliveDeps = {},
): Promise<AccountPoolKeepAliveResult> {
  const pool = getDefaultAccountPool();
  const keepAliveDeps = resolveKeepAliveDeps(deps);
  const result: AccountPoolKeepAliveResult = {
    checked: 0,
    refreshed: 0,
    failed: 0,
  };

  for (const providerId of ACCOUNT_CREDENTIAL_PROVIDER_IDS) {
    await pool.sweepExpired(providerId);
    for (const record of listProviderAccounts(providerId)) {
      result.checked += 1;
      if (pool.get(record.id, providerId)?.health === "expired") continue;

      // A Codex CLI may have rotated the one-time refresh token inside its
      // per-account CODEX_HOME mid-session; adopt it BEFORE resolving, or the
      // refresh below burns on the consumed token and this sweep marks a
      // perfectly recoverable account needs-reauth.
      if (providerId === "openai-codex") {
        await adoptRotatedCodexTokens(record.id);
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
        if (
          providerId === "anthropic-subscription" &&
          accountPoolUsagePrimingEnabled() &&
          accountNeedsUsagePriming(
            pool.get(record.id, "anthropic-subscription"),
            keepAliveDeps.now(),
          )
        ) {
          await primeAnthropicUsageThenRefresh(
            pool,
            record,
            token,
            keepAliveDeps,
          );
        } else {
          await pool.refreshUsage(record.id, token, {
            providerId,
            fetch: keepAliveDeps.fetch,
            ...(record.organizationId
              ? { codexAccountId: record.organizationId }
              : {}),
          });
        }
        result.refreshed += 1;
      } catch (err) {
        result.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        if (/\b(?:HTTP\s*)?(?:401|403)\b|unauthoriz/i.test(message)) {
          await pool.markNeedsReauth(record.id, message, { providerId });
        } else if (/\b(?:HTTP\s*)?429\b|rate.?limit/i.test(message)) {
          await pool.markRateLimited(
            record.id,
            Date.now() + DEFAULT_RATE_LIMIT_BACKOFF_MS,
            message,
            { providerId },
          );
        } else {
          logger.warn(
            `[AccountPool] usage refresh failed for ${providerId}/${record.id} without proving credential failure: ${message}`,
          );
        }
        // Usage parsing, transport, and provider-shape failures do not prove
        // the credential is bad. Keep the current health so a successfully
        // replaced credential cannot be permanently evicted merely because
        // an optional usage endpoint changed shape. Explicit authentication
        // failures above remain terminal; token-resolution failures are
        // handled before this probe.
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
        // error-policy:J1 timer boundary observes rejected sweeps; the next
        // interval retries without translating credential failure to health.
        logger.error(`[AccountPool] keep-alive sweep failed: ${String(err)}`);
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

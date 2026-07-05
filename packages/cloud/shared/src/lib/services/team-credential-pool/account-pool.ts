/**
 * Worker-safe account selection brain for pooled team credentials.
 *
 * The self-host runtime has its own account pool because it also owns local
 * auth files and global provider bridges. Cloud only needs deterministic
 * metadata selection over Drizzle-backed rows, so this implementation keeps the
 * strategy, affinity, and health semantics local to cloud-shared without a
 * runtime dependency on app-core.
 */
import type { LinkedAccountConfig } from "@elizaos/contracts";
import type {
  AccountPool,
  AccountPoolDeps,
  PoolProviderId,
  SelectInput,
  Strategy,
} from "./account-pool-contract";

const QUOTA_AWARE_SKIP_PCT = 85;
const SESSION_AFFINITY_MAX_ATTEMPTS = 3;
const MAX_AFFINITY_ENTRIES = 10_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

interface AffinityEntry {
  accountId: string;
  attempts: number;
}

function accountSessionPct(account: LinkedAccountConfig): number {
  return typeof account.usage?.sessionPct === "number" ? account.usage.sessionPct : 0;
}

function accountLastUsedAt(account: LinkedAccountConfig): number {
  return typeof account.lastUsedAt === "number" ? account.lastUsedAt : 0;
}

function isAccountSelectableNow(account: LinkedAccountConfig, now: number = Date.now()): boolean {
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
        (account) => account.id === accountId && account.providerId === providerId,
      ) ?? null
    );
  }
  const direct = all[accountId];
  if (direct) return direct;
  return Object.values(all).find((account) => account.id === accountId) ?? null;
}

function byPriorityThenAge(a: LinkedAccountConfig, b: LinkedAccountConfig): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return accountLastUsedAt(a) - accountLastUsedAt(b);
}

function byPriorityThenStableIdentity(a: LinkedAccountConfig, b: LinkedAccountConfig): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class TeamCredentialAccountPool implements AccountPool {
  private readonly affinity = new Map<string, AffinityEntry>();
  private readonly roundRobinCursor = new Map<PoolProviderId, number>();
  private readonly recentlySelectedAt = new Map<string, number>();
  private selectionClock = 0;

  constructor(private readonly deps: AccountPoolDeps) {}

  async select(input: SelectInput): Promise<LinkedAccountConfig | null> {
    const eligible = this.filterEligible(this.deps.readAccounts(), input);
    if (eligible.length === 0) return null;

    if (input.sessionKey) {
      const cached = this.affinity.get(input.sessionKey);
      if (
        cached &&
        cached.attempts < SESSION_AFFINITY_MAX_ATTEMPTS &&
        eligible.some((account) => account.id === cached.accountId)
      ) {
        cached.attempts += 1;
        return eligible.find((account) => account.id === cached.accountId) ?? null;
      }
    }

    const picked = this.applyStrategy(input.strategy ?? "priority", eligible, input.providerId);
    if (!picked) return null;
    this.stampSelection(picked.id);

    if (input.sessionKey) {
      this.affinity.set(input.sessionKey, { accountId: picked.id, attempts: 1 });
      while (this.affinity.size > MAX_AFFINITY_ENTRIES) {
        const oldest = this.affinity.keys().next().value;
        if (oldest === undefined) break;
        this.affinity.delete(oldest);
      }
    }
    return picked;
  }

  list(providerId?: PoolProviderId): LinkedAccountConfig[] {
    const all = Object.values(this.deps.readAccounts());
    return providerId ? all.filter((account) => account.providerId === providerId) : all;
  }

  get(accountId: string, providerId?: PoolProviderId): LinkedAccountConfig | null {
    return findAccountById(this.deps.readAccounts(), accountId, providerId);
  }

  async markRateLimited(
    accountId: string,
    untilMs: number,
    detail?: string,
    opts?: { providerId?: PoolProviderId },
  ): Promise<void> {
    const account = findAccountById(this.deps.readAccounts(), accountId, opts?.providerId);
    if (!account) return;
    const providerResetMs = account.usage?.resetsAt;
    const heuristicUntil =
      Number.isFinite(untilMs) && untilMs > Date.now()
        ? untilMs
        : Date.now() + DEFAULT_RATE_LIMIT_BACKOFF_MS;
    await this.deps.writeAccount({
      ...account,
      health: "rate-limited",
      healthDetail: {
        until:
          typeof providerResetMs === "number" && providerResetMs > Date.now()
            ? providerResetMs
            : heuristicUntil,
        lastChecked: Date.now(),
        ...(detail ? { lastError: detail } : {}),
      },
    });
  }

  async markNeedsReauth(
    accountId: string,
    detail?: string,
    opts?: { providerId?: PoolProviderId },
  ): Promise<void> {
    const account = findAccountById(this.deps.readAccounts(), accountId, opts?.providerId);
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

  async reprobeFlagged(): Promise<string[]> {
    const ready: string[] = [];
    const now = Date.now();
    for (const account of Object.values(this.deps.readAccounts())) {
      if (account.health === "ok") continue;
      if (account.health === "rate-limited") {
        const until = account.healthDetail?.until;
        if (typeof until === "number" && until > now) continue;
      }
      ready.push(account.id);
    }
    return ready;
  }

  private filterEligible(
    all: Record<string, LinkedAccountConfig>,
    input: SelectInput,
  ): LinkedAccountConfig[] {
    const exclude = new Set(input.exclude ?? []);
    const explicit =
      input.accountIds && input.accountIds.length > 0 ? new Set(input.accountIds) : null;
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
        const sorted = [...eligible].sort(byPriorityThenStableIdentity);
        const cursor = (this.roundRobinCursor.get(providerId) ?? -1) + 1;
        const index = cursor % sorted.length;
        this.roundRobinCursor.set(providerId, index);
        return sorted[index] ?? null;
      }
      case "least-used":
        return [...eligible].sort((a, b) => this.byLeastUsedEffective(a, b))[0] ?? null;
      case "quota-aware": {
        const underQuota = eligible.filter(
          (account) => accountSessionPct(account) < QUOTA_AWARE_SKIP_PCT,
        );
        const pool = underQuota.length > 0 ? underQuota : eligible;
        return [...pool].sort(byPriorityThenAge)[0] ?? null;
      }
      default:
        return [...eligible].sort(byPriorityThenAge)[0] ?? null;
    }
  }

  private stampSelection(accountId: string): void {
    this.selectionClock = Math.max(Date.now(), this.selectionClock + 1);
    this.recentlySelectedAt.set(accountId, this.selectionClock);
    while (this.recentlySelectedAt.size > MAX_AFFINITY_ENTRIES) {
      const oldest = this.recentlySelectedAt.keys().next().value;
      if (oldest === undefined) break;
      this.recentlySelectedAt.delete(oldest);
    }
  }

  private effectiveLastUsed(account: LinkedAccountConfig): number {
    return Math.max(accountLastUsedAt(account), this.recentlySelectedAt.get(account.id) ?? 0);
  }

  private byLeastUsedEffective(a: LinkedAccountConfig, b: LinkedAccountConfig): number {
    const aPct = accountSessionPct(a);
    const bPct = accountSessionPct(b);
    if (aPct !== bPct) return aPct - bPct;
    const aUsed = this.effectiveLastUsed(a);
    const bUsed = this.effectiveLastUsed(b);
    if (aUsed !== bUsed) return aUsed - bUsed;
    return a.priority - b.priority;
  }
}

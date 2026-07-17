/**
 * Localhost-only account-pool lease broker for same-host compatibility shims.
 * It delegates selection, token resolution, usage accounting, and health
 * mutation to the canonical AccountPool and credential store; callers receive
 * short-lived access tokens but never refresh tokens or display identities.
 */
import { createHash, randomBytes } from "node:crypto";
import { getAccessToken } from "@elizaos/auth/credentials";
import type {
  AccountPoolBrokerAccountSnapshot,
  AccountPoolBrokerFailoverSnapshot,
  AccountPoolBrokerLastReportedStatus,
  AccountPoolBrokerProviderSnapshot,
  AccountPoolBrokerSnapshot,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { LinkedAccountUsage } from "@elizaos/shared/contracts/service-routing";
import { isLinkedAccountProviderId } from "@elizaos/shared/contracts/service-routing";
import {
  type AccountPool,
  getDefaultAccountPool,
  type PoolProviderId,
  type Strategy,
  selectionForProvider,
} from "./account-pool.js";
import {
  claudeMinRemainingMs,
  resolveClaudeExpectedRunMs,
} from "./claude-token-refresh.js";
import {
  adoptRotatedCodexTokens,
  isAuthFailure,
} from "./coding-account-bridge.js";

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const MAX_LEASE_TTL_MS = 15 * 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const DEFAULT_RATE_LIMIT_MS = 60_000;
const FAILOVER_WINDOW_MS = 60_000;
const MAX_RECENT_FAILOVERS = 10;

export interface AccountPoolBrokerLeaseRequest {
  providerId: PoolProviderId;
  sessionKey: string;
  strategy?: Strategy;
  exclude?: string[];
}

export interface AccountPoolBrokerReportRequest {
  leaseId: string;
  ok: boolean;
  httpStatus?: number;
  errorCode?: string;
  retryAfterMs?: number;
  tokens?: number;
  latencyMs?: number;
  model?: string;
}

export interface AccountPoolBrokerReleaseRequest {
  leaseId: string;
}

export interface AccountPoolBrokerLeaseResponse {
  leaseId: string;
  providerId: PoolProviderId;
  accountId: string;
  accessToken: string;
  accessExpiresAt: number;
  leaseExpiresAt: number;
  usage?: LinkedAccountUsage;
  chatgptAccountId?: string;
}

interface LeaseEntry {
  leaseId: string;
  providerId: PoolProviderId;
  accountId: string;
  sessionKey: string;
  sessionKeyHash: string;
  atMs: number;
  expiresAt: number;
  model?: string;
}

interface AccountObservabilityState {
  lastLease: AccountPoolBrokerAccountSnapshot["lastLease"];
  lastReportedStatus: AccountPoolBrokerLastReportedStatus | null;
  lastFailureAtMs: number | null;
}

interface PendingFailoverSignal {
  providerId: PoolProviderId;
  accountId: string;
  sessionKeyHash: string;
  atMs: number;
  cause: AccountPoolBrokerFailoverSnapshot["cause"];
  model?: string;
}

export interface AccountPoolBrokerDeps {
  pool?: AccountPool;
  now?: () => number;
  tokenResolver?: typeof resolveBrokerAccessToken;
  idGenerator?: () => string;
  leaseTtlMs?: number;
}

function normalizeLeaseTtlMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LEASE_TTL_MS;
  }
  return Math.min(Math.max(1_000, value), MAX_LEASE_TTL_MS);
}

function readLeaseTtlFromEnv(): number {
  const raw = process.env.ELIZA_ACCOUNT_POOL_BROKER_LEASE_TTL_MS;
  if (!raw) return DEFAULT_LEASE_TTL_MS;
  return normalizeLeaseTtlMs(Number(raw));
}

function isStrategy(value: unknown): value is Strategy {
  return (
    value === "priority" ||
    value === "round-robin" ||
    value === "least-used" ||
    value === "quota-aware" ||
    value === "reset-soonest"
  );
}

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string")) return undefined;
  const out = value.map((item) => (item as string).trim()).filter(Boolean);
  return out;
}

export function parseBrokerLeaseRequest(
  body: Record<string, unknown>,
): AccountPoolBrokerLeaseRequest | null {
  const providerId = body.providerId;
  const sessionKey = body.sessionKey;
  if (!isLinkedAccountProviderId(providerId)) return null;
  if (typeof sessionKey !== "string" || !sessionKey.trim()) return null;
  const strategy = body.strategy;
  if (strategy !== undefined && !isStrategy(strategy)) return null;
  const exclude = parseStringArray(body.exclude);
  if (body.exclude !== undefined && exclude === undefined) return null;
  return {
    providerId,
    sessionKey: sessionKey.trim(),
    ...(strategy ? { strategy } : {}),
    ...(exclude ? { exclude } : {}),
  };
}

export function parseBrokerReportRequest(
  body: Record<string, unknown>,
): AccountPoolBrokerReportRequest | null {
  if (typeof body.leaseId !== "string" || !body.leaseId.trim()) return null;
  if (typeof body.ok !== "boolean") return null;
  const out: AccountPoolBrokerReportRequest = {
    leaseId: body.leaseId.trim(),
    ok: body.ok,
  };
  for (const key of [
    "httpStatus",
    "retryAfterMs",
    "tokens",
    "latencyMs",
  ] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    out[key] = value;
  }
  for (const key of ["errorCode", "model"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed) out[key] = trimmed.slice(0, 128);
  }
  return out;
}

export function parseBrokerReleaseRequest(
  body: Record<string, unknown>,
): AccountPoolBrokerReleaseRequest | null {
  return typeof body.leaseId === "string" && body.leaseId.trim()
    ? { leaseId: body.leaseId.trim() }
    : null;
}

function makeLeaseId(): string {
  return randomBytes(32).toString("base64url");
}

function hashSessionKey(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
}

function observabilityAccountKey(
  providerId: PoolProviderId,
  accountId: string,
): string {
  return `${providerId}:${accountId}`;
}

function pendingFailoverKey(
  providerId: PoolProviderId,
  sessionKeyHash: string,
): string {
  return `${providerId}:${sessionKeyHash}`;
}

function retryUntilMs(now: number, retryAfterMs: number | undefined): number {
  if (
    typeof retryAfterMs !== "number" ||
    !Number.isFinite(retryAfterMs) ||
    retryAfterMs <= 0
  ) {
    return now + DEFAULT_RATE_LIMIT_MS;
  }
  return now + Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
}

function reportIsAuthFailure(report: AccountPoolBrokerReportRequest): boolean {
  if (report.httpStatus === 401 || report.httpStatus === 403) return true;
  return report.errorCode ? isAuthFailure(report.errorCode) : false;
}

function reportIsRateLimit(report: AccountPoolBrokerReportRequest): boolean {
  if (report.httpStatus === 429) return true;
  return /rate.?limit|quota|subscription/i.test(report.errorCode ?? "");
}

function reportIsTransient(report: AccountPoolBrokerReportRequest): boolean {
  if (
    typeof report.httpStatus === "number" &&
    report.httpStatus >= 500 &&
    report.httpStatus <= 599
  ) {
    return true;
  }
  return /\b(timeout|timed.?out|overload|unavailable|reset|network)\b/i.test(
    report.errorCode ?? "",
  );
}

function normalizeReportCause(
  report: AccountPoolBrokerReportRequest,
): AccountPoolBrokerFailoverSnapshot["cause"] | null {
  // Keep this precedence aligned with report(), which applies rate-limit
  // health before auth when a provider response ambiguously matches both.
  if (reportIsRateLimit(report)) {
    return {
      category: "rate_limit",
      reason: report.httpStatus === 429 ? "http_429" : "rate_limit",
    };
  }
  if (reportIsAuthFailure(report)) {
    return {
      category: "auth",
      reason:
        report.httpStatus === 401
          ? "http_401"
          : report.httpStatus === 403
            ? "http_403"
            : "auth_failed",
    };
  }
  if (reportIsTransient(report)) {
    const status = report.httpStatus;
    return {
      category: "transient",
      reason:
        typeof status === "number" && status >= 500 && status <= 599
          ? "http_5xx"
          : /\b(timeout|timed.?out)\b/i.test(report.errorCode ?? "")
            ? "timeout"
            : /\b(network|reset)\b/i.test(report.errorCode ?? "")
              ? "network"
              : "transient_error",
    };
  }
  return null;
}

function lastReportedStatusFromReport(
  report: AccountPoolBrokerReportRequest,
  atMs: number,
): AccountPoolBrokerLastReportedStatus {
  const failoverCause = normalizeReportCause(report);
  return {
    atMs,
    ok: report.ok,
    category: report.ok ? "ok" : (failoverCause?.category ?? "other"),
    reason: report.ok ? "ok" : (failoverCause?.reason ?? "error"),
    ...(typeof report.httpStatus === "number"
      ? { httpStatus: report.httpStatus }
      : {}),
    ...(report.model ? { model: report.model } : {}),
  };
}

export async function resolveBrokerAccessToken(
  providerId: PoolProviderId,
  accountId: string,
): Promise<{ accessToken: string; accessExpiresAt: number }> {
  if (providerId === "openai-codex") {
    try {
      await adoptRotatedCodexTokens(accountId);
    } catch (err) {
      // error-policy:J7 Codex token adoption is a repair step before canonical
      // token resolution; getAccessToken below remains the observed boundary.
      logger.warn(
        `[AccountPoolBroker] Codex token adoption failed for account ${accountId}: ${String(err)}`,
      );
    }
  }
  const opts =
    providerId === "anthropic-subscription"
      ? {
          minRemainingMs: claudeMinRemainingMs(
            resolveClaudeExpectedRunMs((key) => process.env[key]),
          ),
          outcome: true as const,
        }
      : { outcome: true as const };
  const outcome = await getAccessToken(providerId, accountId, opts);
  if (!outcome.ok) {
    throw new Error(`token_resolve_failed:${outcome.kind}`);
  }
  return {
    accessToken: outcome.accessToken,
    accessExpiresAt: outcome.expiresAt,
  };
}

export class AccountPoolBroker {
  private readonly pool: AccountPool;
  private readonly now: () => number;
  private readonly tokenResolver: typeof resolveBrokerAccessToken;
  private readonly idGenerator: () => string;
  private readonly leaseTtlMs: number;
  private readonly byLeaseId = new Map<string, LeaseEntry>();
  private readonly bySessionKey = new Map<string, string>();
  private readonly accountObservability = new Map<
    string,
    AccountObservabilityState
  >();
  private readonly lastSelectionByProvider = new Map<
    PoolProviderId,
    NonNullable<AccountPoolBrokerProviderSnapshot["lastSelection"]>
  >();
  private readonly recentFailoversByProvider = new Map<
    PoolProviderId,
    AccountPoolBrokerFailoverSnapshot[]
  >();
  private readonly pendingFailoversBySession = new Map<
    string,
    PendingFailoverSignal
  >();

  constructor(deps: AccountPoolBrokerDeps = {}) {
    this.pool = deps.pool ?? getDefaultAccountPool();
    this.now = deps.now ?? Date.now;
    this.tokenResolver = deps.tokenResolver ?? resolveBrokerAccessToken;
    this.idGenerator = deps.idGenerator ?? makeLeaseId;
    this.leaseTtlMs = normalizeLeaseTtlMs(
      deps.leaseTtlMs ?? readLeaseTtlFromEnv(),
    );
  }

  async lease(
    request: AccountPoolBrokerLeaseRequest,
  ): Promise<AccountPoolBrokerLeaseResponse | null> {
    this.pruneExpired();
    const now = this.now();
    const exclude = new Set(request.exclude ?? []);
    const pinned = this.resolveSessionPin(request.sessionKey);
    const configured = selectionForProvider(request.providerId);
    const account =
      pinned &&
      pinned.providerId === request.providerId &&
      !exclude.has(pinned.accountId) &&
      (!configured.accountIds ||
        configured.accountIds.includes(pinned.accountId))
        ? await this.pool.select({
            providerId: request.providerId,
            sessionKey: request.sessionKey,
            strategy: request.strategy ?? configured.strategy,
            accountIds: [pinned.accountId],
          })
        : null;
    const selected =
      account ??
      (await this.pool.select({
        providerId: request.providerId,
        sessionKey: request.sessionKey,
        strategy: request.strategy ?? configured.strategy,
        ...(configured.accountIds ? { accountIds: configured.accountIds } : {}),
        exclude: request.exclude,
      }));
    if (!selected) return null;

    const token = await this.tokenResolver(request.providerId, selected.id);
    const leaseId = this.idGenerator();
    const leaseExpiresAt = now + this.leaseTtlMs;
    const sessionKeyHash = hashSessionKey(request.sessionKey);
    const lease: LeaseEntry = {
      leaseId,
      providerId: request.providerId,
      accountId: selected.id,
      sessionKey: request.sessionKey,
      sessionKeyHash,
      atMs: now,
      expiresAt: leaseExpiresAt,
    };
    this.byLeaseId.set(leaseId, lease);
    this.bySessionKey.set(request.sessionKey, leaseId);
    this.observeLease(lease, request.strategy ?? configured.strategy);

    return {
      leaseId,
      providerId: request.providerId,
      accountId: selected.id,
      accessToken: token.accessToken,
      accessExpiresAt: token.accessExpiresAt,
      leaseExpiresAt,
      ...(selected.usage ? { usage: selected.usage } : {}),
      ...(request.providerId === "openai-codex" && selected.organizationId
        ? { chatgptAccountId: selected.organizationId }
        : {}),
    };
  }

  async report(
    report: AccountPoolBrokerReportRequest,
  ): Promise<
    { ok: true } | { ok: false; error: "unknown_lease" | "expired_lease" }
  > {
    const lease = this.byLeaseId.get(report.leaseId);
    if (!lease) return { ok: false, error: "unknown_lease" };
    if (lease.expiresAt <= this.now()) {
      this.deleteLease(lease);
      return { ok: false, error: "expired_lease" };
    }
    const reportAt = this.now();
    const observability = this.ensureAccountObservability(
      lease.providerId,
      lease.accountId,
    );
    if (report.model) {
      lease.model = report.model;
      if (observability.lastLease?.leaseId === lease.leaseId) {
        observability.lastLease = {
          ...observability.lastLease,
          model: report.model,
        };
      }
    }
    const successPredatesFailure =
      report.ok &&
      observability.lastFailureAtMs !== null &&
      lease.atMs <= observability.lastFailureAtMs;
    if (!successPredatesFailure) {
      observability.lastReportedStatus = lastReportedStatusFromReport(
        report,
        reportAt,
      );
    }
    if (!report.ok) observability.lastFailureAtMs = reportAt;

    await this.pool.recordCall(
      lease.accountId,
      {
        ok: report.ok,
        ...(report.tokens !== undefined ? { tokens: report.tokens } : {}),
        ...(report.latencyMs !== undefined
          ? { latencyMs: report.latencyMs }
          : {}),
        ...(report.errorCode ? { errorCode: report.errorCode } : {}),
        ...(report.model ? { model: report.model } : {}),
      },
      { providerId: lease.providerId },
    );

    if (report.ok) {
      const pendingKey = pendingFailoverKey(
        lease.providerId,
        lease.sessionKeyHash,
      );
      const pending = this.pendingFailoversBySession.get(pendingKey);
      if (pending?.accountId === lease.accountId) {
        this.pendingFailoversBySession.delete(pendingKey);
      }
      if (!successPredatesFailure) {
        await this.pool.markHealthy(lease.accountId, {
          providerId: lease.providerId,
        });
      }
      return { ok: true };
    }

    const failoverCause = normalizeReportCause(report);
    if (failoverCause) {
      this.pendingFailoversBySession.set(
        pendingFailoverKey(lease.providerId, lease.sessionKeyHash),
        {
          providerId: lease.providerId,
          accountId: lease.accountId,
          sessionKeyHash: lease.sessionKeyHash,
          atMs: reportAt,
          cause: failoverCause,
          ...(report.model ? { model: report.model } : {}),
        },
      );
    }

    if (reportIsRateLimit(report)) {
      await this.pool.markRateLimited(
        lease.accountId,
        retryUntilMs(this.now(), report.retryAfterMs),
        report.errorCode ?? "rate_limited",
        { providerId: lease.providerId },
      );
      this.deleteLease(lease);
      return { ok: true };
    }

    if (reportIsAuthFailure(report)) {
      await this.pool.markNeedsReauth(
        lease.accountId,
        report.errorCode ?? "auth_failed",
        { providerId: lease.providerId },
      );
      this.deleteLease(lease);
      return { ok: true };
    }

    if (reportIsTransient(report)) {
      return { ok: true };
    }

    return { ok: true };
  }

  release(request: AccountPoolBrokerReleaseRequest): {
    ok: true;
    released: boolean;
  } {
    const lease = this.byLeaseId.get(request.leaseId);
    if (!lease) return { ok: true, released: false };
    this.deleteLease(lease);
    return { ok: true, released: true };
  }

  health(): {
    ok: true;
    enabled: true;
    providers: Array<{
      providerId: PoolProviderId;
      total: number;
      enabled: number;
      selectable: number;
      lastSelection: AccountPoolBrokerProviderSnapshot["lastSelection"];
    }>;
    activeLeases: number;
    accounts: Record<
      string,
      {
        activeLeaseCount: number;
        lastLeaseAt: number | null;
        lastReportedStatus: AccountPoolBrokerLastReportedStatus | null;
      }
    >;
  } {
    this.pruneExpired();
    const now = this.now();
    const snapshot = this.snapshot();
    const providers = new Set<PoolProviderId>(
      this.pool.list().map((account) => account.providerId),
    );
    return {
      ok: true,
      enabled: true,
      activeLeases: this.byLeaseId.size,
      accounts: Object.fromEntries(
        Object.entries(snapshot.accounts).map(([accountId, account]) => [
          accountId,
          {
            activeLeaseCount: account.activeLeaseCount,
            lastLeaseAt: account.lastLeaseAt,
            lastReportedStatus: account.lastReportedStatus,
          },
        ]),
      ),
      providers: [...providers].sort().map((providerId) => {
        const accounts = this.pool.list(providerId);
        return {
          providerId,
          total: accounts.length,
          enabled: accounts.filter((account) => account.enabled).length,
          lastSelection: this.lastSelectionByProvider.get(providerId) ?? null,
          selectable: accounts.filter(
            (account) =>
              account.enabled &&
              (account.health === "ok" ||
                (account.health === "rate-limited" &&
                  typeof account.healthDetail?.until === "number" &&
                  account.healthDetail.until < now)),
          ).length,
        };
      }),
    };
  }

  snapshot(): AccountPoolBrokerSnapshot {
    this.pruneExpired();
    const activeCounts = new Map<string, number>();
    for (const lease of this.byLeaseId.values()) {
      const key = observabilityAccountKey(lease.providerId, lease.accountId);
      activeCounts.set(key, (activeCounts.get(key) ?? 0) + 1);
    }

    const accounts: AccountPoolBrokerSnapshot["accounts"] = {};
    for (const account of this.pool.list()) {
      const key = observabilityAccountKey(account.providerId, account.id);
      const state = this.accountObservability.get(key);
      accounts[key] = {
        activeLeaseCount: activeCounts.get(key) ?? 0,
        lastLease: state?.lastLease ?? null,
        lastLeaseAt: state?.lastLease?.atMs ?? null,
        lastReportedStatus: state?.lastReportedStatus ?? null,
      };
    }
    for (const [key, state] of this.accountObservability) {
      accounts[key] ??= {
        activeLeaseCount: activeCounts.get(key) ?? 0,
        lastLease: state.lastLease,
        lastLeaseAt: state.lastLease?.atMs ?? null,
        lastReportedStatus: state.lastReportedStatus,
      };
    }

    const providerIds = new Set<PoolProviderId>([
      ...this.pool.list().map((account) => account.providerId),
      ...this.lastSelectionByProvider.keys(),
      ...this.recentFailoversByProvider.keys(),
    ]);
    const providers: AccountPoolBrokerSnapshot["providers"] = {};
    for (const providerId of providerIds) {
      providers[providerId] = {
        lastSelection: this.lastSelectionByProvider.get(providerId) ?? null,
        recentFailovers: [
          ...(this.recentFailoversByProvider.get(providerId) ?? []),
        ],
      };
    }
    return { accounts, providers };
  }

  private observeLease(lease: LeaseEntry, reason: string | undefined): void {
    const state = this.ensureAccountObservability(
      lease.providerId,
      lease.accountId,
    );
    state.lastLease = {
      leaseId: lease.leaseId,
      atMs: lease.atMs,
      sessionKeyHash: lease.sessionKeyHash,
      ...(lease.model ? { model: lease.model } : {}),
    };
    this.lastSelectionByProvider.set(lease.providerId, {
      accountId: lease.accountId,
      atMs: lease.atMs,
      reason: reason ?? "priority",
    });

    const pendingKey = pendingFailoverKey(
      lease.providerId,
      lease.sessionKeyHash,
    );
    const pending = this.pendingFailoversBySession.get(pendingKey);
    if (!pending) return;
    this.pendingFailoversBySession.delete(pendingKey);
    if (
      pending.accountId === lease.accountId ||
      lease.atMs - pending.atMs > FAILOVER_WINDOW_MS
    ) {
      return;
    }
    const failover: AccountPoolBrokerFailoverSnapshot = {
      atMs: lease.atMs,
      providerId: lease.providerId,
      sessionKeyHash: lease.sessionKeyHash,
      fromAccountId: pending.accountId,
      toAccountId: lease.accountId,
      cause: pending.cause,
      ...(pending.model ? { model: pending.model } : {}),
    };
    const recent = this.recentFailoversByProvider.get(lease.providerId) ?? [];
    recent.push(failover);
    this.recentFailoversByProvider.set(
      lease.providerId,
      recent.slice(-MAX_RECENT_FAILOVERS),
    );
  }

  private ensureAccountObservability(
    providerId: PoolProviderId,
    accountId: string,
  ): AccountObservabilityState {
    const key = observabilityAccountKey(providerId, accountId);
    let state = this.accountObservability.get(key);
    if (!state) {
      state = {
        lastLease: null,
        lastReportedStatus: null,
        lastFailureAtMs: null,
      };
      this.accountObservability.set(key, state);
    }
    return state;
  }

  private resolveSessionPin(sessionKey: string): LeaseEntry | null {
    const leaseId = this.bySessionKey.get(sessionKey);
    if (!leaseId) return null;
    const lease = this.byLeaseId.get(leaseId);
    if (!lease || lease.expiresAt <= this.now()) {
      if (lease) this.deleteLease(lease);
      else this.bySessionKey.delete(sessionKey);
      return null;
    }
    return lease;
  }

  private deleteLease(lease: LeaseEntry): void {
    this.byLeaseId.delete(lease.leaseId);
    if (this.bySessionKey.get(lease.sessionKey) === lease.leaseId) {
      this.bySessionKey.delete(lease.sessionKey);
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const lease of this.byLeaseId.values()) {
      if (lease.expiresAt <= now) this.deleteLease(lease);
    }
    for (const [sessionKey, pending] of this.pendingFailoversBySession) {
      if (now - pending.atMs > FAILOVER_WINDOW_MS) {
        this.pendingFailoversBySession.delete(sessionKey);
      }
    }
  }
}

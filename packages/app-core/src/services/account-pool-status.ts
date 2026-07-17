/**
 * Public-safe account-pool status snapshots for anonymous capacity reporting.
 *
 * This service reads the default account-pool metadata and consumer metering
 * totals, derives aggregate burn/projection signals, and persists only the
 * anonymized fields needed to compare future snapshots within the same reset
 * window. The HTTP route must serialize through the allowlist here; raw
 * account, consumer, key, and lease records never cross this boundary.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { logger, resolveStateDir } from "@elizaos/core";
import type { LinkedAccountConfig } from "@elizaos/shared/contracts/service-routing";
import {
  type AccountPool,
  getDefaultAccountPool,
  isAccountSelectableNow,
  selectionForProvider,
} from "./account-pool.js";
import {
  type AccountPoolConsumerUsageBreakdown,
  type AccountPoolConsumerUsageTotals,
  getAccountPoolConsumerUsageSummary,
  type queryAccountPoolConsumerUsage,
} from "./account-pool-consumer-metering.js";

type PublicAccountState = "serving" | "draining" | "exhausted";
type CapacityState = "EXHAUSTED" | "BURNING HOT" | "OK" | "FRESH";

interface WeeklyModelBucketCompat {
  pct?: unknown;
  utilization?: unknown;
  resetsAt?: unknown;
}

type UsageCompat = NonNullable<LinkedAccountConfig["usage"]> & {
  sessionResetsAt?: unknown;
  weeklyResetsAt?: unknown;
  weeklyModelBuckets?: Record<string, WeeklyModelBucketCompat>;
};

export interface PublicPoolModelBucket {
  usedPct: number;
}

export type PublicPoolModelBuckets =
  | {
      available: true;
      fable: PublicPoolModelBucket | null;
      sonnet: PublicPoolModelBucket | null;
    }
  | {
      available: false;
      note: string;
    };

interface InternalPoolModelBucket extends PublicPoolModelBucket {
  resetAt: number | null;
}

type InternalPoolModelBuckets =
  | {
      available: true;
      fable: InternalPoolModelBucket | null;
      sonnet: InternalPoolModelBucket | null;
    }
  | {
      available: false;
      note: string;
    };

interface InternalPoolStatusAccount {
  /** Stable local identity for persisted burn snapshots. Never serialized. */
  snapshotKey: string;
  name: string;
  accountState: PublicAccountState;
  sessionUsedPct: number | null;
  sessionHeadroomPct: number | null;
  sessionResetAt: number | null;
  sessionResetIn: string | null;
  weeklyUsedPct: number | null;
  weeklyHeadroomPct: number | null;
  weeklyResetAt: number | null;
  weeklyResetIn: string | null;
  fableUsedPct: number | null;
  modelBuckets: InternalPoolModelBuckets;
  burnRatePctPerHour: number | null;
  burnSampleHours: number | null;
  projectedExhaustionIn: string | null;
  projectedBeforeReset: boolean | null;
  state: CapacityState;
  exhaustionMessage: string;
}

export interface PublicPoolStatusAccount {
  name: string;
  accountState: PublicAccountState;
  sessionUsedPct: number | null;
  sessionHeadroomPct: number | null;
  sessionResetIn: string | null;
  weeklyUsedPct: number | null;
  weeklyHeadroomPct: number | null;
  weeklyResetIn: string | null;
  fableUsedPct: number | null;
  modelBuckets: PublicPoolModelBuckets;
  burnRatePctPerHour: number | null;
  burnSampleHours: number | null;
  projectedExhaustionIn: string | null;
  projectedBeforeReset: boolean | null;
  state: CapacityState;
  exhaustionMessage: string;
}

export interface PublicPoolStatus {
  updatedAt: string;
  usageRefreshedAt: string | null;
  pool: {
    accounts: number;
    capacityPct: number;
    selectableAccounts: number;
  };
  fable: {
    leftPct: number;
    ofPct: number;
    source: "fable weekly bucket" | "all-model weekly fallback";
  };
  allModels: {
    leftPct: number;
    ofPct: number;
  };
  perAccount: PublicPoolStatusAccount[];
  publicEdge: {
    today: PublicPoolConsumerTotals;
    allTime: PublicPoolConsumerTotals;
  };
  urgency: {
    burnRatePctPerHour: number | null;
    projectedDepletionIn: string | null;
    depletionMessage: string;
    nextRefill: {
      account: string;
      in: string;
      capacityAddedPct: number;
    } | null;
  };
  health: {
    snapshotAgeSeconds: number;
    snapshotAge: string;
    stale: boolean;
  };
}

interface InternalPoolStatus extends Omit<PublicPoolStatus, "perAccount"> {
  perAccount: InternalPoolStatusAccount[];
}

export interface PublicPoolConsumerTotals {
  requests: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  errors: number;
  latencyMs: number;
}

interface StatusSnapshotAccount {
  snapshotKey: string;
  name: string;
  weeklyUsedPct: number | null;
  fableUsedPct: number | null;
  weeklyResetAt: number | null;
}

interface StatusSnapshot {
  ts: number;
  accounts: StatusSnapshotAccount[];
}

interface AccountPoolStatusDeps {
  pool?: AccountPool;
  queryConsumerUsage?: typeof queryAccountPoolConsumerUsage;
  now?: () => number;
  stateDir?: () => string;
  cacheTtlMs?: number;
  snapshotMaxLines?: number;
}

interface BurnEstimate {
  ratePctPerHour: number | null;
  sampleHours: number | null;
}

const STATUS_TTL_MS = 60_000;
const SNAPSHOT_MAX_LINES = 2_000;
const SNAPSHOT_RESET_TOLERANCE_MS = 5 * 60_000;
const STORE_DIR = "account-pool";
const SNAPSHOTS_FILE = "public-status-snapshots.jsonl";
const PROVIDER_ID = "anthropic-subscription";

let cache: { at: number; status: InternalPoolStatus } | null = null;
let inflight: Promise<InternalPoolStatus> | null = null;
let depsOverride: AccountPoolStatusDeps = {};

function nowMs(): number {
  return depsOverride.now?.() ?? Date.now();
}

function stateDir(): string {
  return depsOverride.stateDir?.() ?? resolveStateDir();
}

function snapshotFile(): string {
  return path.join(stateDir(), STORE_DIR, SNAPSHOTS_FILE);
}

function cacheTtlMs(): number {
  return depsOverride.cacheTtlMs ?? STATUS_TTL_MS;
}

function snapshotMaxLines(): number {
  return depsOverride.snapshotMaxLines ?? SNAPSHOT_MAX_LINES;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function atomicWriteText(filePath: string, value: string): void {
  ensureDir(filePath);
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString(
      "hex",
    )}.tmp`,
  );
  writeFileSync(tmp, value, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, filePath);
}

function clampPct(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : null;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function snapshotKey(account: LinkedAccountConfig): string {
  return createHash("sha256")
    .update(`${account.providerId}:${account.id}`, "utf8")
    .digest("hex");
}

function durationText(ms: number | null): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  if (ms <= 0) return "now";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `~${days}d ${hours}h`;
  if (hours > 0) return `~${hours}h ${mins}m`;
  return `~${mins}m`;
}

function resetText(ms: number | null): string | null {
  const duration = durationText(ms);
  if (!duration) return null;
  if (duration === "now") return "reset due";
  return `resets in ${duration.replace(/^~/, "")}`;
}

function compactAge(ms: number): string {
  if (ms < 60_000) return "<1m";
  return durationText(ms)?.replace(/^~/, "") ?? "unknown";
}

function readSnapshots(): StatusSnapshot[] {
  const file = snapshotFile();
  if (!existsSync(file)) return [];
  const snapshots: StatusSnapshot[] = [];
  const raw = readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as StatusSnapshot;
      if (typeof parsed.ts !== "number" || !Array.isArray(parsed.accounts)) {
        continue;
      }
      snapshots.push({
        ts: parsed.ts,
        accounts: parsed.accounts
          .filter(
            (account) =>
              typeof account.name === "string" &&
              typeof account.snapshotKey === "string",
          )
          .map((account) => ({
            snapshotKey: account.snapshotKey,
            name: account.name,
            weeklyUsedPct: clampPct(account.weeklyUsedPct),
            fableUsedPct: clampPct(account.fableUsedPct),
            weeklyResetAt:
              typeof account.weeklyResetAt === "number"
                ? account.weeklyResetAt
                : null,
          })),
      });
    } catch (error) {
      // error-policy:J3 persisted snapshots are local diagnostic input; a bad
      // line is invalid history, not a reason to fail the public status route.
      logger.warn(
        `[account-pool-status] skipping invalid snapshot line: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return snapshots;
}

function appendSnapshot(status: InternalPoolStatus): void {
  const snapshot: StatusSnapshot = {
    ts: nowMs(),
    accounts: status.perAccount.map((account) => ({
      snapshotKey: account.snapshotKey,
      name: account.name,
      weeklyUsedPct: account.weeklyUsedPct,
      fableUsedPct: account.fableUsedPct,
      weeklyResetAt: account.weeklyResetAt,
    })),
  };
  const file = snapshotFile();
  ensureDir(file);
  appendFileSync(file, `${JSON.stringify(snapshot)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const max = snapshotMaxLines();
  if (lines.length > max) {
    atomicWriteText(file, `${lines.slice(-max).join("\n")}\n`);
  }
}

function getModelBuckets(usage: UsageCompat): InternalPoolModelBuckets {
  const source = usage.weeklyModelBuckets ?? {};
  let fable: InternalPoolModelBucket | null = null;
  let sonnet: InternalPoolModelBucket | null = null;
  for (const [key, value] of Object.entries(source)) {
    const usedPct = clampPct(value?.pct ?? value?.utilization);
    if (usedPct === null) continue;
    const bucket: InternalPoolModelBucket = {
      usedPct: round2(usedPct),
      resetAt: typeof value.resetsAt === "number" ? value.resetsAt : null,
    };
    if (/fable/i.test(key)) fable = bucket;
    if (/sonnet/i.test(key)) sonnet = bucket;
  }
  if (fable || sonnet) return { available: true, fable, sonnet };
  return {
    available: false,
    note: "per-model buckets pending account usage support",
  };
}

function calculateBurn(
  row: InternalPoolStatusAccount,
  snapshots: readonly StatusSnapshot[],
  now: number,
): BurnEstimate {
  if (row.fableUsedPct === null || row.weeklyResetAt === null) {
    return { ratePctPerHour: null, sampleHours: null };
  }
  const candidates: { ts: number; used: number }[] = [];
  for (const snapshot of snapshots) {
    const old = snapshot.accounts.find(
      (account) => account.snapshotKey === row.snapshotKey,
    );
    if (!old || snapshot.ts >= now) continue;
    if (
      old.weeklyResetAt === null ||
      Math.abs(old.weeklyResetAt - row.weeklyResetAt) >
        SNAPSHOT_RESET_TOLERANCE_MS
    ) {
      continue;
    }
    if (old.fableUsedPct === null || old.fableUsedPct > row.fableUsedPct) {
      continue;
    }
    candidates.push({ ts: snapshot.ts, used: old.fableUsedPct });
  }
  if (candidates.length === 0) {
    return { ratePctPerHour: null, sampleHours: null };
  }
  candidates.sort((a, b) => a.ts - b.ts);
  const oldest = candidates[0];
  const hours = (now - oldest.ts) / 3_600_000;
  if (!oldest || hours <= 0) {
    return { ratePctPerHour: null, sampleHours: null };
  }
  return {
    ratePctPerHour: Math.max(0, (row.fableUsedPct - oldest.used) / hours),
    sampleHours: hours,
  };
}

function applyUrgency(
  status: InternalPoolStatus,
  snapshots: readonly StatusSnapshot[],
): void {
  const now = nowMs();
  let totalRate = 0;
  let knownRates = 0;
  for (const row of status.perAccount) {
    const burn = calculateBurn(row, snapshots, now);
    const rate = burn.ratePctPerHour;
    row.burnRatePctPerHour = rate === null ? null : round2(rate);
    row.burnSampleHours =
      burn.sampleHours === null ? null : round2(burn.sampleHours);
    const resetMs = row.weeklyResetAt === null ? null : row.weeklyResetAt - now;
    row.weeklyResetIn = resetText(resetMs);
    row.sessionResetIn =
      row.sessionResetAt === null ? null : resetText(row.sessionResetAt - now);
    const exhaustMs =
      row.fableUsedPct !== null && rate !== null && rate > 0
        ? ((100 - row.fableUsedPct) / rate) * 3_600_000
        : null;
    row.projectedExhaustionIn = durationText(exhaustMs);
    row.projectedBeforeReset =
      exhaustMs !== null && resetMs !== null ? exhaustMs < resetMs : null;
    if (row.fableUsedPct !== null && row.fableUsedPct >= 100) {
      row.state = "EXHAUSTED";
    } else if (row.projectedBeforeReset === true) {
      row.state = "BURNING HOT";
    } else if (row.fableUsedPct !== null && row.fableUsedPct <= 5) {
      row.state = "FRESH";
    } else {
      row.state = "OK";
    }
    if (rate === null) {
      row.exhaustionMessage = "at current burn: estimating";
    } else if (rate === 0 || row.projectedBeforeReset === false) {
      row.exhaustionMessage = "at current burn: will not run out before reset";
    } else {
      row.exhaustionMessage = `at current burn: runs out in ${durationText(
        exhaustMs,
      )}`;
    }
    if (rate !== null) {
      totalRate += rate;
      knownRates += 1;
    }
  }
  const rank: Record<CapacityState, number> = {
    EXHAUSTED: 0,
    "BURNING HOT": 1,
    OK: 2,
    FRESH: 3,
  };
  status.perAccount.sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    return (b.fableUsedPct ?? -1) - (a.fableUsedPct ?? -1);
  });
  const next = status.perAccount
    .filter((account) => account.weeklyResetAt !== null)
    .filter((account) => (account.weeklyResetAt ?? 0) > now)
    .sort((a, b) => (a.weeklyResetAt ?? 0) - (b.weeklyResetAt ?? 0))[0];
  const poolMs =
    totalRate > 0 ? (status.fable.leftPct / totalRate) * 3_600_000 : null;
  status.urgency = {
    burnRatePctPerHour: knownRates > 0 ? round2(totalRate) : null,
    projectedDepletionIn: durationText(poolMs),
    depletionMessage:
      knownRates === 0
        ? "pool-wide burn: estimating"
        : totalRate === 0
          ? "pool-wide burn is currently flat"
          : `pool-wide capacity at current burn: ${durationText(poolMs)}`,
    nextRefill:
      next && next.weeklyResetAt !== null
        ? {
            account: next.name,
            in: durationText(next.weeklyResetAt - now) ?? "unknown",
            capacityAddedPct: round2(
              next.fableUsedPct ?? next.weeklyUsedPct ?? 0,
            ),
          }
        : null,
  };
}

function consumerTotals(
  totals: AccountPoolConsumerUsageTotals["totals"],
): PublicPoolConsumerTotals {
  return {
    requests: totals.requests,
    tokens: totals.tokens,
    inputTokens: totals.input_tokens,
    outputTokens: totals.output_tokens,
    cacheReadInputTokens: totals.cache_read_input_tokens,
    cacheCreationInputTokens: totals.cache_creation_input_tokens,
    errors: totals.errors,
    latencyMs: totals.latencyMs,
  };
}

function currentDayStamp(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function publicEdgeUsage(
  usage: AccountPoolConsumerUsageBreakdown,
  now: number,
): PublicPoolStatus["publicEdge"] {
  const today =
    usage.byDay[currentDayStamp(now)] ??
    ({
      requests: 0,
      tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      errors: 0,
      latencyMs: 0,
    } satisfies AccountPoolConsumerUsageTotals["totals"]);
  return {
    today: consumerTotals(today),
    allTime: consumerTotals(usage.totals),
  };
}

function buildStatus(
  pool: AccountPool,
  consumerUsage: AccountPoolConsumerUsageBreakdown,
  snapshots: readonly StatusSnapshot[],
): InternalPoolStatus {
  const now = nowMs();
  const configured = selectionForProvider(PROVIDER_ID);
  const configuredIds = configured.accountIds
    ? new Set(configured.accountIds)
    : null;
  const accounts = pool
    .list(PROVIDER_ID)
    .filter((account) => account.enabled !== false)
    .filter(
      (account) => configuredIds === null || configuredIds.has(account.id),
    )
    .filter((account) => isAccountSelectableNow(account, now));
  if (accounts.length === 0) {
    throw new Error("no selectable public pool accounts");
  }
  const selection = pool.selectionState(
    PROVIDER_ID,
    configured.strategy ?? "drain-soonest-reset",
    configured.accountIds ? { accountIds: configured.accountIds } : undefined,
  );
  let fableLeft = 0;
  let allLeft = 0;
  let fableKnownAccounts = 0;
  let allModelsKnownAccounts = 0;
  let fableFromBucket = true;
  let lastRefreshed = 0;
  const rows: InternalPoolStatusAccount[] = accounts.map((account, index) => {
    const usage = (account.usage ?? { refreshedAt: 0 }) as UsageCompat;
    if (typeof usage.refreshedAt === "number") {
      lastRefreshed = Math.max(lastRefreshed, usage.refreshedAt);
    }
    const weeklyAll = clampPct(usage.weeklyPct);
    const sessionPct = clampPct(usage.sessionPct);
    const modelBuckets = getModelBuckets(usage);
    const fableUsed =
      modelBuckets.available && modelBuckets.fable
        ? modelBuckets.fable.usedPct
        : weeklyAll;
    if (!(modelBuckets.available && modelBuckets.fable)) {
      fableFromBucket = false;
    }
    if (fableUsed !== null) {
      fableLeft += 100 - fableUsed;
      fableKnownAccounts += 1;
    }
    if (weeklyAll !== null) {
      allLeft += 100 - weeklyAll;
      allModelsKnownAccounts += 1;
    }
    const fallbackWeeklyResetAt =
      typeof usage.resetsAt === "number"
        ? usage.resetsAt
        : typeof usage.weeklyResetsAt === "number"
          ? usage.weeklyResetsAt
          : null;
    const weeklyResetAt =
      modelBuckets.available && modelBuckets.fable
        ? (modelBuckets.fable.resetAt ?? fallbackWeeklyResetAt)
        : fallbackWeeklyResetAt;
    const exhausted = fableUsed !== null && fableUsed >= 100;
    const serving =
      selection.activeAccountId === account.id &&
      isAccountSelectableNow(account, now);
    return {
      snapshotKey: snapshotKey(account),
      name: `account-${index + 1}`,
      accountState: exhausted ? "exhausted" : serving ? "serving" : "draining",
      sessionUsedPct: sessionPct === null ? null : round2(sessionPct),
      sessionHeadroomPct: sessionPct === null ? null : round2(100 - sessionPct),
      sessionResetAt:
        typeof usage.sessionResetsAt === "number"
          ? usage.sessionResetsAt
          : null,
      sessionResetIn: null,
      weeklyUsedPct: weeklyAll === null ? null : round2(weeklyAll),
      weeklyHeadroomPct: weeklyAll === null ? null : round2(100 - weeklyAll),
      weeklyResetAt,
      weeklyResetIn: null,
      fableUsedPct: fableUsed === null ? null : round2(fableUsed),
      modelBuckets,
      burnRatePctPerHour: null,
      burnSampleHours: null,
      projectedExhaustionIn: null,
      projectedBeforeReset: null,
      state: "OK",
      exhaustionMessage: "at current burn: estimating",
    };
  });
  const status: InternalPoolStatus = {
    updatedAt: new Date(now).toISOString(),
    usageRefreshedAt: lastRefreshed
      ? new Date(lastRefreshed).toISOString()
      : null,
    pool: {
      accounts: accounts.length,
      capacityPct: accounts.length * 100,
      selectableAccounts: accounts.filter((account) =>
        isAccountSelectableNow(account, now),
      ).length,
    },
    fable: {
      leftPct: round2(fableLeft),
      ofPct: fableKnownAccounts * 100,
      source: fableFromBucket
        ? "fable weekly bucket"
        : "all-model weekly fallback",
    },
    allModels: {
      leftPct: round2(allLeft),
      ofPct: allModelsKnownAccounts * 100,
    },
    perAccount: rows,
    publicEdge: publicEdgeUsage(consumerUsage, now),
    urgency: {
      burnRatePctPerHour: null,
      projectedDepletionIn: null,
      depletionMessage: "pool-wide burn: estimating",
      nextRefill: null,
    },
    health: {
      snapshotAgeSeconds: 0,
      snapshotAge: "<1m",
      stale: false,
    },
  };
  applyUrgency(status, snapshots);
  return status;
}

function withHealth(
  status: InternalPoolStatus,
  stale: boolean,
): InternalPoolStatus {
  const now = nowMs();
  const ageSeconds = Math.max(0, Math.round((now - (cache?.at ?? now)) / 1000));
  return {
    ...status,
    health: {
      snapshotAgeSeconds: ageSeconds,
      snapshotAge: compactAge(ageSeconds * 1000),
      stale,
    },
  };
}

function publicModelBuckets(
  buckets: InternalPoolModelBuckets,
): PublicPoolModelBuckets {
  if (!buckets.available) {
    return { available: false, note: buckets.note };
  }
  return {
    available: true,
    fable: buckets.fable ? { usedPct: buckets.fable.usedPct } : null,
    sonnet: buckets.sonnet ? { usedPct: buckets.sonnet.usedPct } : null,
  };
}

export function serializePublicPoolStatus(
  status: InternalPoolStatus,
): PublicPoolStatus {
  return {
    updatedAt: status.updatedAt,
    usageRefreshedAt: status.usageRefreshedAt,
    pool: {
      accounts: status.pool.accounts,
      capacityPct: status.pool.capacityPct,
      selectableAccounts: status.pool.selectableAccounts,
    },
    fable: {
      leftPct: status.fable.leftPct,
      ofPct: status.fable.ofPct,
      source: status.fable.source,
    },
    allModels: {
      leftPct: status.allModels.leftPct,
      ofPct: status.allModels.ofPct,
    },
    perAccount: status.perAccount.map((account) => ({
      name: account.name,
      accountState: account.accountState,
      sessionUsedPct: account.sessionUsedPct,
      sessionHeadroomPct: account.sessionHeadroomPct,
      sessionResetIn: account.sessionResetIn,
      weeklyUsedPct: account.weeklyUsedPct,
      weeklyHeadroomPct: account.weeklyHeadroomPct,
      weeklyResetIn: account.weeklyResetIn,
      fableUsedPct: account.fableUsedPct,
      modelBuckets: publicModelBuckets(account.modelBuckets),
      burnRatePctPerHour: account.burnRatePctPerHour,
      burnSampleHours: account.burnSampleHours,
      projectedExhaustionIn: account.projectedExhaustionIn,
      projectedBeforeReset: account.projectedBeforeReset,
      state: account.state,
      exhaustionMessage: account.exhaustionMessage,
    })),
    publicEdge: {
      today: { ...status.publicEdge.today },
      allTime: { ...status.publicEdge.allTime },
    },
    urgency: {
      burnRatePctPerHour: status.urgency.burnRatePctPerHour,
      projectedDepletionIn: status.urgency.projectedDepletionIn,
      depletionMessage: status.urgency.depletionMessage,
      nextRefill: status.urgency.nextRefill
        ? {
            account: status.urgency.nextRefill.account,
            in: status.urgency.nextRefill.in,
            capacityAddedPct: status.urgency.nextRefill.capacityAddedPct,
          }
        : null,
    },
    health: {
      snapshotAgeSeconds: status.health.snapshotAgeSeconds,
      snapshotAge: status.health.snapshotAge,
      stale: status.health.stale,
    },
  };
}

export async function getPublicAccountPoolStatus(): Promise<PublicPoolStatus> {
  const now = nowMs();
  if (cache && now - cache.at < cacheTtlMs()) {
    return serializePublicPoolStatus(withHealth(cache.status, false));
  }
  if (!inflight) {
    inflight = (async () => {
      const history = readSnapshots();
      const pool = depsOverride.pool ?? getDefaultAccountPool();
      const usage = await (
        depsOverride.queryConsumerUsage ?? getAccountPoolConsumerUsageSummary
      )();
      const status = buildStatus(pool, usage, history);
      cache = { at: nowMs(), status };
      appendSnapshot(status);
      return status;
    })()
      .catch((error) => {
        logger.warn(
          `[AccountPoolStatus] status refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (cache) return withHealth(cache.status, true);
        throw error;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return serializePublicPoolStatus(await inflight);
}

export function __resetAccountPoolStatusForTests(
  deps: AccountPoolStatusDeps = {},
): void {
  depsOverride = deps;
  cache = null;
  inflight = null;
}

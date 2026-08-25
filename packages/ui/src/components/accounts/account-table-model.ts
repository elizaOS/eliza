/**
 * account-table-model - pure derivation + sorting for the desktop account
 * command-center table.
 *
 * Kept DOM-free so the health-badge mapping, usage extraction, sort
 * comparators, and (critically) the observability feature-detection can be
 * unit-tested without a renderer. The table component is a thin projection of
 * these functions.
 */

import type { AccountWithCredentialFlag } from "../../api/client-agent";
import { weeklyResetAt } from "./reset-time";

export type { AccountWithCredentialFlag };

/**
 * Number.isFinite is not a type predicate, so it cannot narrow an optional
 * numeric field. Coerce explicitly so comparators stay total under strict
 * null checks.
 */
function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export type AccountHealthTone = "success" | "warning" | "danger" | "muted";

export interface AccountHealthDescriptor {
  /** i18n key for the badge label. */
  key: string;
  /** Fallback label used when no translation is registered. */
  fallback: string;
  tone: AccountHealthTone;
  /**
   * epoch ms this state expires (rate-limit reset). Drives the row-level
   * countdown; undefined for non-expiring states.
   */
  until?: number;
  /** Optional detail string (last error) for the tooltip. */
  detail?: string;
}

/**
 * Map a raw account health into a stable, tone-tagged descriptor. Keeping this
 * exhaustive (with an `unknown` fallback) means an unrecognized server value
 * degrades to a muted badge instead of throwing.
 */
export function describeHealth(
  account: AccountWithCredentialFlag,
): AccountHealthDescriptor {
  const detail = account.healthDetail?.lastError?.trim() || undefined;
  switch (account.health) {
    case "ok":
      return {
        key: "accounts.table.health.ok",
        fallback: "Healthy",
        tone: "success",
      };
    case "rate-limited":
      return {
        key: "accounts.table.health.rateLimited",
        fallback: "Rate-limited",
        tone: "warning",
        until: account.healthDetail?.until,
        detail,
      };
    case "needs-reauth":
      return {
        key: "accounts.table.health.needsReauth",
        fallback: "Needs reauth",
        tone: "danger",
        detail,
      };
    case "invalid":
      return {
        key: "accounts.table.health.invalid",
        fallback: "Invalid",
        tone: "danger",
        detail,
      };
    case "expired":
      return {
        key: "accounts.table.health.expired",
        fallback: "Expired",
        tone: "danger",
        detail,
      };
    default:
      return {
        key: "accounts.table.health.unknown",
        fallback: "Unknown",
        tone: "muted",
        detail,
      };
  }
}

/** True when the account's credential must be repaired before it can serve. */
export function needsCredentialRepair(
  account: AccountWithCredentialFlag,
): boolean {
  return (
    account.health === "needs-reauth" ||
    account.health === "invalid" ||
    account.health === "expired"
  );
}

/**
 * Rank health worst→best so a "sort by health" surfaces the accounts that need
 * attention at the top. Lower rank = more urgent.
 */
const HEALTH_RANK: Record<string, number> = {
  invalid: 0,
  expired: 1,
  "needs-reauth": 2,
  "rate-limited": 3,
  unknown: 4,
  ok: 5,
};

function healthRank(account: AccountWithCredentialFlag): number {
  return HEALTH_RANK[account.health] ?? HEALTH_RANK.unknown;
}

/**
 * "Worst" usage figure for sort/among the bars - the higher of session/weekly,
 * so an account that's blown either window sorts as heavily-used. Returns -1
 * when no usage snapshot exists so unknowns sink below known values.
 */
export function peakUsagePct(
  account: AccountWithCredentialFlag,
): number | null {
  const usage = account.usage;
  if (!usage) return null;
  const values = [usage.sessionPct, usage.weeklyPct].filter(
    (v): v is number => typeof v === "number" && !Number.isNaN(v),
  );
  if (values.length === 0) return null;
  return Math.max(...values);
}

export type AccountSortKey = "health" | "usage" | "lastUsed" | "priority";
export type SortDirection = "asc" | "desc";

export interface AccountSort {
  key: AccountSortKey;
  direction: SortDirection;
}

/** Default: most-urgent health first (the reason to open the table at all). */
export const DEFAULT_ACCOUNT_SORT: AccountSort = {
  key: "health",
  direction: "asc",
};

/**
 * Direction-aware comparator. Returns the ordered delta for the two rows
 * already accounting for `direction`, so callers do not post-multiply. This
 * lets the `usage` column keep unknown-usage rows pinned to the BOTTOM in both
 * ascending and descending order (a column of "-" is never useful at the top).
 */
function compareByKey(
  a: AccountWithCredentialFlag,
  b: AccountWithCredentialFlag,
  sort: AccountSort,
): number {
  const factor = sort.direction === "asc" ? 1 : -1;
  switch (sort.key) {
    case "health":
      return (healthRank(a) - healthRank(b)) * factor;
    case "usage": {
      const au = peakUsagePct(a);
      const bu = peakUsagePct(b);
      // Unknown usage always sinks regardless of direction: sort known values
      // by the requested direction, and push nulls to the end either way.
      if (au == null && bu == null) return 0;
      if (au == null) return 1;
      if (bu == null) return -1;
      return (au - bu) * factor;
    }
    case "lastUsed":
      return (finiteOrZero(a.lastUsedAt) - finiteOrZero(b.lastUsedAt)) * factor;
    case "priority":
      return (finiteOrZero(a.priority) - finiteOrZero(b.priority)) * factor;
    default:
      return 0;
  }
}

/**
 * Stable sort by the chosen column. Ties break on priority (the pool's own
 * ordering) then id, so re-renders don't reshuffle equal rows.
 */
export function sortAccounts(
  accounts: readonly AccountWithCredentialFlag[],
  sort: AccountSort,
): AccountWithCredentialFlag[] {
  return [...accounts].sort((a, b) => {
    const primary = compareByKey(a, b, sort);
    if (primary !== 0) return primary;
    if (a.priority !== b.priority) {
      return (
        (Number.isFinite(a.priority) ? a.priority : 0) -
        (Number.isFinite(b.priority) ? b.priority : 0)
      );
    }
    return a.id.localeCompare(b.id);
  });
}

/**
 * Feature-detection: does the payload actually carry lease observability?
 * #16355 adds `observability` to every account, but until it merges (and on
 * older hosts) the field is absent. We hide the lease column entirely rather
 * than render a column of zeros that lie about activity.
 */
export function hasLeaseObservability(
  accounts: readonly AccountWithCredentialFlag[],
): boolean {
  return accounts.some((account) => account.observability != null);
}

/**
 * The governing WEEKLY reset instant for a row. Session/rate-limit cooldowns
 * remain in the health cell and must never be relabelled as weekly resets.
 */
export function rowResetAt(
  account: AccountWithCredentialFlag,
): number | undefined {
  return weeklyResetAt(account);
}

export interface WeeklyModelBucket {
  pct: number;
  resetsAt?: number;
}

/** Consume the parser's model buckets while degrading on older hosts. */
export function fableWeeklyBucket(
  account: AccountWithCredentialFlag,
): WeeklyModelBucket | undefined {
  const usage = account.usage as
    | (NonNullable<typeof account.usage> & {
        weeklyModelBuckets?: Record<string, WeeklyModelBucket>;
      })
    | undefined;
  const buckets = usage?.weeklyModelBuckets;
  if (!buckets) return undefined;
  return Object.entries(buckets).find(([name]) =>
    name.toLocaleLowerCase().includes("fable"),
  )?.[1];
}

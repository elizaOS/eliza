/**
 * reset-time — shared formatting + ordering for weekly-limit reset windows.
 *
 * The rotation policy (see account-pool `reset-soonest`) prefers the account
 * whose weekly budget refunds SOONEST, because spending a budget that's about
 * to reset costs the least. These helpers keep the UI copy ("resets in 2d 4h")
 * and the "which resets first" ordering identical to the backend intent.
 */

import type { AccountWithCredentialFlag } from "../../api/client-agent";

/** Compact human duration for a future reset instant. Null when past/absent. */
export function formatResetIn(epochMs: number | undefined): string | null {
  if (!epochMs) return null;
  const diff = epochMs - Date.now();
  if (diff <= 0) return null;
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.max(1, minutes)}m`;
}

/**
 * Best available neutral reset/cooldown instant. Used only for legacy drain
 * ordering and neutral "resets in" copy, never as a weekly-window label.
 */
export function accountResetAt(
  account: AccountWithCredentialFlag,
): number | undefined {
  return account.usage?.resetsAt ?? account.healthDetail?.until;
}

/**
 * A reset explicitly known to govern the all-model weekly budget.
 *
 * `resetsAt` is provider-specific by contract: Anthropic stores its all-model
 * seven-day reset there, while Codex stores its primary five-hour reset. An
 * explicit future `weeklyResetsAt` wins; otherwise only Anthropic may use the
 * canonical `resetsAt` value as weekly.
 */
export function weeklyResetAt(
  account: AccountWithCredentialFlag,
): number | undefined {
  const usage = account.usage as
    | (NonNullable<typeof account.usage> & {
        weeklyResetsAt?: number;
        weeklyModelBuckets?: Record<string, unknown>;
      })
    | undefined;
  if (!usage) return undefined;
  if (typeof usage.weeklyResetsAt === "number") return usage.weeklyResetsAt;
  if (account.providerId === "anthropic-subscription") return usage.resetsAt;
  return undefined;
}
/**
 * Order accounts by "reset soonest first". Accounts with a known reset
 * instant come before those without; unknowns fall back to least-recently
 * used (proxy for least-recently-throttled) so the ordering is still stable.
 */
/**
 * Number.isFinite is not a type predicate, so it cannot narrow an optional
 * numeric field. Coerce explicitly so the comparator stays total under strict
 * null checks.
 */
function finiteOrZeroTimestamp(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function bySoonestReset(
  a: AccountWithCredentialFlag,
  b: AccountWithCredentialFlag,
): number {
  const ar = accountResetAt(a);
  const br = accountResetAt(b);
  if (ar != null && br != null) {
    if (ar !== br) {
      return (Number.isFinite(ar) ? ar : 0) - (Number.isFinite(br) ? br : 0);
    }
  } else if (ar != null) {
    return -1;
  } else if (br != null) {
    return 1;
  }
  // Both unknown: least-recently-used first (held-in-reserve heuristic).
  return (
    finiteOrZeroTimestamp(a.lastUsedAt) - finiteOrZeroTimestamp(b.lastUsedAt)
  );
}

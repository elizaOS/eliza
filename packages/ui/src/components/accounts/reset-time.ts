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
 * The reset instant that governs an account's weekly budget. Prefers the
 * usage snapshot's `resetsAt`; falls back to a live rate-limit `until`.
 */
export function accountResetAt(
  account: AccountWithCredentialFlag,
): number | undefined {
  return account.usage?.resetsAt ?? account.healthDetail?.until;
}

/**
 * Order accounts by "reset soonest first". Accounts with a known reset
 * instant come before those without; unknowns fall back to least-recently
 * used (proxy for least-recently-throttled) so the ordering is still stable.
 */
export function bySoonestReset(
  a: AccountWithCredentialFlag,
  b: AccountWithCredentialFlag,
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
  // Both unknown: least-recently-used first (held-in-reserve heuristic).
  return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0);
}

/**
 * Default pack: `quiet-user-watcher`.
 *
 * One daily watcher `ScheduledTask` (kind = "watcher") that consults
 * `RecentTaskStatesProvider.summarize` and surfaces:
 *   - "you've been quiet for N days" when no recent owner replies
 *   - "you missed yesterday's check-in" when the previous-day check-in
 *     terminal-stated `expired` or `skipped` without a follow-up reply.
 *
 * Threshold: 3 days quiet (per IMPL §3.4 owned-files note).
 *
 * Closes journey J5 (user-quiet concern). The watcher emits its observations
 * for the morning-brief pack to fold in; it does **not** send a separate
 * notification (that's what the consolidation policy on `wake.confirmed` is
 * for — see `consolidation-policies.ts`).
 *
 * Stub status: see `contract-stubs.ts` — `RecentTaskStatesProvider` is
 * declared locally until W1-C ships the real provider.
 */

import type {
  RecentTaskStatesProvider,
  RecentTaskStatesSummary,
  ScheduledTaskSeed,
} from "./contract-stubs.js";
import type { DefaultPack } from "./registry-types.js";

export const QUIET_USER_WATCHER_PACK_KEY = "quiet-user-watcher";

export const QUIET_USER_WATCHER_RECORD_IDS = {
  watcher: "default-pack:quiet-user-watcher:daily",
} as const;

/**
 * Default threshold for "been quiet" — 3 calendar days with no owner reply
 * across any tracked check-in / followup. Configurable per-task via
 * `metadata.quietThresholdDays`.
 */
export const QUIET_THRESHOLD_DAYS = 3;

const watcherRecord: ScheduledTaskSeed = {
  kind: "watcher",
  promptInstructions:
    "Consult RecentTaskStatesProvider.summarize for owner activity over the last week. If the owner has been quiet for the configured threshold, surface a quiet-user observation. If yesterday's check-in expired without reply, surface a missed-check-in observation. Emit observations for the morning-brief consolidation; do not send a separate notification.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { lookbackHours: 24 * 7 },
  },
  // Daily fire on the morning anchor so the morning-brief consolidation can
  // pick up the observation in the same wake.confirmed batch.
  trigger: {
    kind: "relative_to_anchor",
    anchorKey: "wake.confirmed",
    offsetMinutes: 0,
  },
  priority: "low",
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: QUIET_USER_WATCHER_PACK_KEY,
  // Watcher tasks emit observations; their output is consumed by the
  // morning-brief consolidation, not surfaced to the owner directly.
  ownerVisible: false,
  idempotencyKey: QUIET_USER_WATCHER_RECORD_IDS.watcher,
  metadata: {
    packKey: QUIET_USER_WATCHER_PACK_KEY,
    recordKey: "quiet-user-watcher",
    quietThresholdDays: QUIET_THRESHOLD_DAYS,
  },
};

export const quietUserWatcherPack: DefaultPack = {
  key: QUIET_USER_WATCHER_PACK_KEY,
  label: "Quiet-user watcher",
  description:
    "Daily watcher that flags long silences and missed check-ins. Surfaces observations into the morning brief instead of sending its own notification.",
  defaultEnabled: true,
  records: [watcherRecord],
  uiHints: {
    summaryOnDayOne:
      "Daily silent watcher; only surfaces text when you've been quiet 3+ days or skipped yesterday's check-in.",
    expectedFireCountPerDay: 0,
  },
};

// -- helpers used by the watcher when it actually runs --

export interface QuietUserWatcherObservation {
  kind: "quiet_for_days" | "missed_yesterday_checkin";
  days?: number;
  detail: string;
}

/**
 * Pure helper: turn a `RecentTaskStatesSummary` into observations the
 * morning-brief should fold in. Pure because the watcher task itself is
 * what the runner schedules; this helper just shapes the output.
 */
export function deriveQuietObservations(
  summary: RecentTaskStatesSummary,
  options: { thresholdDays?: number } = {},
): QuietUserWatcherObservation[] {
  const threshold = options.thresholdDays ?? QUIET_THRESHOLD_DAYS;
  const observations: QuietUserWatcherObservation[] = [];

  // Streak shape: a series of consecutive checkins that ended in `expired`
  // (or `skipped`) means the owner hasn't been replying. We treat any
  // expired/skipped streak >= threshold as "quiet".
  for (const streak of summary.streaks) {
    const counts =
      (streak.kind === "checkin" || streak.kind === "followup") &&
      (streak.outcome === "expired" || streak.outcome === "skipped")
        ? streak.consecutive
        : 0;
    if (counts >= threshold) {
      observations.push({
        kind: "quiet_for_days",
        days: counts,
        detail: `${counts} consecutive ${streak.kind}s without reply`,
      });
      break;
    }
  }

  // Missed-yesterday-checkin: a one-step streak of `expired` checkin counts.
  for (const streak of summary.streaks) {
    if (
      streak.kind === "checkin" &&
      streak.outcome === "expired" &&
      streak.consecutive >= 1
    ) {
      observations.push({
        kind: "missed_yesterday_checkin",
        detail: "yesterday's check-in expired without reply",
      });
      break;
    }
  }

  return observations;
}

/**
 * Convenience wrapper for the runtime: ask the provider for a summary, then
 * derive observations.
 */
export async function runQuietUserWatcher(
  provider: RecentTaskStatesProvider,
  options: { thresholdDays?: number; lookbackDays?: number } = {},
): Promise<QuietUserWatcherObservation[]> {
  const summary = await provider.summarize({
    kinds: ["checkin", "followup"],
    lookbackDays: options.lookbackDays ?? 7,
  });
  return deriveQuietObservations(summary, {
    thresholdDays: options.thresholdDays,
  });
}

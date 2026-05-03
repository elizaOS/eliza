import type {
  LifeOpsDefinitionPerformance,
  LifeOpsDefinitionPerformanceWindow,
  LifeOpsOccurrence,
  LifeOpsOverviewSection,
  LifeOpsOverviewSummary,
  LifeOpsTaskDefinition,
} from "../contracts/index.js";
import {
  DEFINITION_PERFORMANCE_LAST7_DAYS,
  DEFINITION_PERFORMANCE_LAST30_DAYS,
} from "./service-constants.js";
import { getZonedDateParts } from "./time.js";

export function _createEmptyOverviewSection(): LifeOpsOverviewSection {
  return {
    occurrences: [],
    goals: [],
    reminders: [],
    summary: {
      activeOccurrenceCount: 0,
      overdueOccurrenceCount: 0,
      snoozedOccurrenceCount: 0,
      activeReminderCount: 0,
      activeGoalCount: 0,
    },
  };
}

export function summarizeOverviewSection(
  section: Pick<LifeOpsOverviewSection, "occurrences" | "goals" | "reminders">,
  now: Date,
): LifeOpsOverviewSummary {
  return {
    activeOccurrenceCount: section.occurrences.filter(
      (occurrence) =>
        occurrence.state === "visible" || occurrence.state === "snoozed",
    ).length,
    overdueOccurrenceCount: section.occurrences.filter((occurrence) => {
      if (!occurrence.dueAt) return false;
      const dueAt = new Date(occurrence.dueAt).getTime();
      return dueAt < now.getTime() && occurrence.state !== "completed";
    }).length,
    snoozedOccurrenceCount: section.occurrences.filter(
      (occurrence) => occurrence.state === "snoozed",
    ).length,
    activeReminderCount: section.reminders.length,
    activeGoalCount: section.goals.length,
  };
}

export function occurrenceAnchorIso(
  occurrence: LifeOpsOccurrence,
): string | null {
  return (
    occurrence.dueAt ??
    occurrence.scheduledAt ??
    occurrence.relevanceStartAt ??
    null
  );
}

export function occurrenceAnchorMs(occurrence: LifeOpsOccurrence): number {
  const anchor = occurrenceAnchorIso(occurrence);
  if (!anchor) {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = Date.parse(anchor);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function occurrenceDayKey(
  occurrence: LifeOpsOccurrence,
  timeZone: string,
): string | null {
  const anchor = occurrenceAnchorIso(occurrence);
  if (!anchor) {
    return null;
  }
  const parts = getZonedDateParts(new Date(anchor), timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function buildPerformanceWindow(
  occurrences: LifeOpsOccurrence[],
  timeZone: string,
  windowStartMs: number,
  nowMs: number,
): LifeOpsDefinitionPerformanceWindow {
  const scheduled = occurrences.filter((occurrence) => {
    const anchorMs = occurrenceAnchorMs(occurrence);
    return (
      anchorMs !== Number.MAX_SAFE_INTEGER &&
      anchorMs >= windowStartMs &&
      anchorMs <= nowMs
    );
  });
  const completedCount = scheduled.filter(
    (occurrence) => occurrence.state === "completed",
  ).length;
  const skippedCount = scheduled.filter(
    (occurrence) => occurrence.state === "skipped",
  ).length;
  const pendingCount = scheduled.length - completedCount - skippedCount;
  const perfectDays = new Map<string, { perfect: boolean; anchorMs: number }>();
  for (const occurrence of scheduled) {
    const dayKey = occurrenceDayKey(occurrence, timeZone);
    if (!dayKey) {
      continue;
    }
    const anchorMs = occurrenceAnchorMs(occurrence);
    const current = perfectDays.get(dayKey);
    const nextPerfect = occurrence.state === "completed";
    if (!current) {
      perfectDays.set(dayKey, {
        perfect: nextPerfect,
        anchorMs,
      });
      continue;
    }
    perfectDays.set(dayKey, {
      perfect: current.perfect && nextPerfect,
      anchorMs: Math.min(current.anchorMs, anchorMs),
    });
  }
  return {
    scheduledCount: scheduled.length,
    completedCount,
    skippedCount,
    pendingCount,
    completionRate:
      scheduled.length > 0 ? completedCount / scheduled.length : 0,
    perfectDayCount: [...perfectDays.values()].filter((day) => day.perfect)
      .length,
  };
}

type StreakOccurrence = Pick<LifeOpsOccurrence, "state">;

export function computeOccurrenceStreaks(
  dueOccurrences: readonly StreakOccurrence[],
): {
  current: number;
  best: number;
} {
  let currentRun = 0;
  let bestRun = 0;
  for (const occurrence of dueOccurrences) {
    if (occurrence.state === "completed") {
      currentRun += 1;
      if (currentRun > bestRun) {
        bestRun = currentRun;
      }
    } else {
      currentRun = 0;
    }
  }

  let current = 0;
  for (let index = dueOccurrences.length - 1; index >= 0; index -= 1) {
    if (dueOccurrences[index]?.state !== "completed") {
      break;
    }
    current += 1;
  }

  return {
    current,
    best: bestRun,
  };
}

export function computeMissedOccurrenceStreak(
  dueOccurrences: readonly StreakOccurrence[],
): {
  current: number;
  best: number;
} {
  let currentRun = 0;
  let bestRun = 0;
  for (const occurrence of dueOccurrences) {
    if (occurrence.state !== "completed") {
      currentRun += 1;
      if (currentRun > bestRun) {
        bestRun = currentRun;
      }
    } else {
      currentRun = 0;
    }
  }

  let current = 0;
  for (let index = dueOccurrences.length - 1; index >= 0; index -= 1) {
    if (dueOccurrences[index]?.state === "completed") {
      break;
    }
    current += 1;
  }

  return {
    current,
    best: bestRun,
  };
}

export function computePerfectDayStreaks(
  dueOccurrences: LifeOpsOccurrence[],
  timeZone: string,
): { current: number; best: number } {
  const grouped = new Map<string, { perfect: boolean; anchorMs: number }>();
  for (const occurrence of dueOccurrences) {
    const dayKey = occurrenceDayKey(occurrence, timeZone);
    if (!dayKey) {
      continue;
    }
    const anchorMs = occurrenceAnchorMs(occurrence);
    const current = grouped.get(dayKey);
    const nextPerfect = occurrence.state === "completed";
    if (!current) {
      grouped.set(dayKey, {
        perfect: nextPerfect,
        anchorMs,
      });
      continue;
    }
    grouped.set(dayKey, {
      perfect: current.perfect && nextPerfect,
      anchorMs: Math.min(current.anchorMs, anchorMs),
    });
  }

  const days = [...grouped.values()].sort(
    (left, right) => left.anchorMs - right.anchorMs,
  );
  let bestRun = 0;
  let activeRun = 0;
  for (const day of days) {
    if (day.perfect) {
      activeRun += 1;
      if (activeRun > bestRun) {
        bestRun = activeRun;
      }
    } else {
      activeRun = 0;
    }
  }

  let current = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (!days[index]?.perfect) {
      break;
    }
    current += 1;
  }

  return {
    current,
    best: bestRun,
  };
}

export function computeDefinitionPerformance(
  definition: LifeOpsTaskDefinition,
  occurrences: LifeOpsOccurrence[],
  now: Date,
): LifeOpsDefinitionPerformance {
  const nowMs = now.getTime();
  const dueOccurrences = occurrences
    .filter((occurrence) => occurrenceAnchorMs(occurrence) <= nowMs)
    .sort(
      (left, right) => occurrenceAnchorMs(left) - occurrenceAnchorMs(right),
    );
  const lastCompletedAt =
    dueOccurrences
      .filter((occurrence) => occurrence.state === "completed")
      .map((occurrence) => Date.parse(occurrence.updatedAt))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => right - left)[0] ?? null;
  const lastSkippedAt =
    dueOccurrences
      .filter((occurrence) => occurrence.state === "skipped")
      .map((occurrence) => Date.parse(occurrence.updatedAt))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => right - left)[0] ?? null;
  const totalCompletedCount = dueOccurrences.filter(
    (occurrence) => occurrence.state === "completed",
  ).length;
  const totalSkippedCount = dueOccurrences.filter(
    (occurrence) => occurrence.state === "skipped",
  ).length;
  const totalPendingCount =
    dueOccurrences.length - totalCompletedCount - totalSkippedCount;
  const occurrenceStreaks = computeOccurrenceStreaks(dueOccurrences);
  const perfectDayStreaks = computePerfectDayStreaks(
    dueOccurrences,
    definition.timezone,
  );
  const last7Days = buildPerformanceWindow(
    dueOccurrences,
    definition.timezone,
    nowMs - DEFINITION_PERFORMANCE_LAST7_DAYS * 24 * 60 * 60 * 1000,
    nowMs,
  );
  const last30Days = buildPerformanceWindow(
    dueOccurrences,
    definition.timezone,
    nowMs - DEFINITION_PERFORMANCE_LAST30_DAYS * 24 * 60 * 60 * 1000,
    nowMs,
  );
  const lastActivityAtMs =
    [lastCompletedAt, lastSkippedAt]
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => right - left)[0] ?? null;

  return {
    lastCompletedAt:
      typeof lastCompletedAt === "number"
        ? new Date(lastCompletedAt).toISOString()
        : null,
    lastSkippedAt:
      typeof lastSkippedAt === "number"
        ? new Date(lastSkippedAt).toISOString()
        : null,
    lastActivityAt:
      typeof lastActivityAtMs === "number"
        ? new Date(lastActivityAtMs).toISOString()
        : null,
    totalScheduledCount: dueOccurrences.length,
    totalCompletedCount,
    totalSkippedCount,
    totalPendingCount,
    currentOccurrenceStreak: occurrenceStreaks.current,
    bestOccurrenceStreak: occurrenceStreaks.best,
    currentPerfectDayStreak: perfectDayStreaks.current,
    bestPerfectDayStreak: perfectDayStreaks.best,
    last7Days,
    last30Days,
  };
}

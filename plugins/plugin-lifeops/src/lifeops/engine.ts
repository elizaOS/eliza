import type {
  LifeOpsCadence,
  LifeOpsOccurrence,
  LifeOpsOccurrenceState,
  LifeOpsProgressionRule,
  LifeOpsTaskDefinition,
  LifeOpsTimeWindowDefinition,
} from "../contracts/index.js";
import { normalizeWindowPolicy } from "./defaults.js";
import {
  addDaysToLocalDate,
  addMinutes,
  buildUtcDateFromLocalParts,
  getLocalDateKey,
  getWeekdayForLocalDate,
  getZonedDateParts,
  type ZonedDateParts,
} from "./time.js";

export interface MaterializeDefinitionOccurrencesOptions {
  now?: Date;
  lookbackDays?: number;
  lookaheadDays?: number;
}

const DEFAULT_LOOKBACK_DAYS = 2;
const DEFAULT_LOOKAHEAD_DAYS = 7;

function isTerminalOccurrenceState(state: LifeOpsOccurrenceState): boolean {
  return state === "completed" || state === "skipped" || state === "muted";
}

function resolveLeadMinutes(cadence: LifeOpsCadence): number {
  if (cadence.kind === "once") {
    return cadence.visibilityLeadMinutes ?? 15;
  }
  if (cadence.kind === "times_per_day" || cadence.kind === "interval") {
    return cadence.visibilityLeadMinutes ?? 15;
  }
  return cadence.visibilityLeadMinutes ?? 0;
}

function resolveLagMinutes(cadence: LifeOpsCadence): number {
  if (cadence.kind === "once") {
    return cadence.visibilityLagMinutes ?? 6 * 60;
  }
  if (cadence.kind === "times_per_day") {
    return cadence.visibilityLagMinutes ?? 4 * 60;
  }
  if (cadence.kind === "interval") {
    return (
      cadence.visibilityLagMinutes ?? Math.min(cadence.everyMinutes, 4 * 60)
    );
  }
  return cadence.visibilityLagMinutes ?? 0;
}

function resolveOccurrenceState(
  currentState: LifeOpsOccurrenceState | null | undefined,
  relevanceStartAt: Date,
  relevanceEndAt: Date,
  now: Date,
  snoozedUntil: string | null,
): LifeOpsOccurrenceState {
  if (currentState && isTerminalOccurrenceState(currentState)) {
    return currentState;
  }
  if (snoozedUntil) {
    const snoozedDate = new Date(snoozedUntil);
    if (snoozedDate.getTime() > now.getTime()) {
      return "snoozed";
    }
  }
  if (now.getTime() > relevanceEndAt.getTime()) {
    return "expired";
  }
  if (now.getTime() >= relevanceStartAt.getTime()) {
    return "visible";
  }
  return "pending";
}

function deriveTarget(
  progressionRule: LifeOpsProgressionRule,
  completedCountBefore: number,
): Record<string, unknown> | null {
  if (progressionRule.kind === "none") {
    return null;
  }
  const target =
    progressionRule.start + completedCountBefore * progressionRule.step;
  return {
    kind: progressionRule.kind,
    metric: progressionRule.metric,
    target,
    step: progressionRule.step,
    start: progressionRule.start,
    unit: progressionRule.unit ?? null,
    completedCountBefore,
  };
}

function buildOccurrenceKey(
  prefix: string,
  localDateKey: string,
  suffix: string,
): string {
  return `${prefix}:${localDateKey}:${suffix}`;
}

function getCadenceWindows(cadence: LifeOpsCadence): string[] {
  const windows = (cadence as { windows?: string[] }).windows;
  return Array.isArray(windows) ? windows : [];
}

function buildWindowOccurrence(
  definition: LifeOpsTaskDefinition,
  existing: LifeOpsOccurrence | undefined,
  window: LifeOpsTimeWindowDefinition,
  localDate: Pick<ZonedDateParts, "year" | "month" | "day">,
  localDateKey: string,
  completedCountBefore: number,
  cadencePrefix: string,
  now: Date,
): LifeOpsOccurrence {
  const cadence = definition.cadence;
  const leadMinutes = resolveLeadMinutes(cadence);
  const lagMinutes = resolveLagMinutes(cadence);
  const startDayOffset = Math.floor(window.startMinute / (24 * 60));
  const endDayOffset = Math.floor(window.endMinute / (24 * 60));
  const startMinuteOfDay = window.startMinute % (24 * 60);
  const endMinuteOfDay = window.endMinute % (24 * 60);
  const startDate = addDaysToLocalDate(localDate, startDayOffset);
  const endDate = addDaysToLocalDate(localDate, endDayOffset);
  const startLocal = {
    ...startDate,
    hour: Math.floor(startMinuteOfDay / 60),
    minute: startMinuteOfDay % 60,
    second: 0,
  } satisfies ZonedDateParts;
  const endLocal = {
    ...endDate,
    hour: Math.floor(endMinuteOfDay / 60),
    minute: endMinuteOfDay % 60,
    second: 0,
  } satisfies ZonedDateParts;
  const scheduledAt = buildUtcDateFromLocalParts(
    definition.timezone,
    startLocal,
  );
  const dueAt = buildUtcDateFromLocalParts(definition.timezone, endLocal);
  const relevanceStartAt = addMinutes(scheduledAt, -leadMinutes);
  const relevanceEndAt = addMinutes(dueAt, lagMinutes);
  const occurrenceKey = buildOccurrenceKey(
    cadencePrefix,
    localDateKey,
    window.name,
  );
  return {
    id: existing?.id ?? crypto.randomUUID(),
    agentId: definition.agentId,
    domain: definition.domain,
    subjectType: definition.subjectType,
    subjectId: definition.subjectId,
    visibilityScope: definition.visibilityScope,
    contextPolicy: definition.contextPolicy,
    definitionId: definition.id,
    occurrenceKey,
    scheduledAt: scheduledAt.toISOString(),
    dueAt: dueAt.toISOString(),
    relevanceStartAt: relevanceStartAt.toISOString(),
    relevanceEndAt: relevanceEndAt.toISOString(),
    windowName: window.name,
    state: resolveOccurrenceState(
      existing?.state,
      relevanceStartAt,
      relevanceEndAt,
      now,
      existing?.snoozedUntil ?? null,
    ),
    snoozedUntil: existing?.snoozedUntil ?? null,
    completionPayload: existing?.completionPayload ?? null,
    derivedTarget: deriveTarget(
      definition.progressionRule,
      completedCountBefore,
    ),
    metadata: {
      ...(existing?.metadata ?? {}),
      localDateKey,
      cadenceKind: definition.cadence.kind,
    },
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function buildSlotOccurrence(
  definition: LifeOpsTaskDefinition,
  existing: LifeOpsOccurrence | undefined,
  slot: NonNullable<
    Extract<LifeOpsCadence, { kind: "times_per_day" }>["slots"]
  >[number],
  localDate: Pick<ZonedDateParts, "year" | "month" | "day">,
  localDateKey: string,
  completedCountBefore: number,
  now: Date,
): LifeOpsOccurrence {
  const cadence = definition.cadence;
  const leadMinutes = resolveLeadMinutes(cadence);
  const lagMinutes = Math.max(resolveLagMinutes(cadence), slot.durationMinutes);
  const scheduledLocal = {
    ...localDate,
    hour: Math.floor(slot.minuteOfDay / 60),
    minute: slot.minuteOfDay % 60,
    second: 0,
  } satisfies ZonedDateParts;
  const scheduledAt = buildUtcDateFromLocalParts(
    definition.timezone,
    scheduledLocal,
  );
  const dueAt = scheduledAt;
  const relevanceStartAt = addMinutes(scheduledAt, -leadMinutes);
  const relevanceEndAt = addMinutes(scheduledAt, lagMinutes);
  const occurrenceKey = buildOccurrenceKey("slot", localDateKey, slot.key);
  return {
    id: existing?.id ?? crypto.randomUUID(),
    agentId: definition.agentId,
    domain: definition.domain,
    subjectType: definition.subjectType,
    subjectId: definition.subjectId,
    visibilityScope: definition.visibilityScope,
    contextPolicy: definition.contextPolicy,
    definitionId: definition.id,
    occurrenceKey,
    scheduledAt: scheduledAt.toISOString(),
    dueAt: dueAt.toISOString(),
    relevanceStartAt: relevanceStartAt.toISOString(),
    relevanceEndAt: relevanceEndAt.toISOString(),
    windowName: slot.label,
    state: resolveOccurrenceState(
      existing?.state,
      relevanceStartAt,
      relevanceEndAt,
      now,
      existing?.snoozedUntil ?? null,
    ),
    snoozedUntil: existing?.snoozedUntil ?? null,
    completionPayload: existing?.completionPayload ?? null,
    derivedTarget: deriveTarget(
      definition.progressionRule,
      completedCountBefore,
    ),
    metadata: {
      ...(existing?.metadata ?? {}),
      localDateKey,
      cadenceKind: definition.cadence.kind,
      slotKey: slot.key,
    },
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function buildIntervalOccurrence(
  definition: LifeOpsTaskDefinition,
  existing: LifeOpsOccurrence | undefined,
  args: {
    localDateKey: string;
    intervalKey: string;
    scheduledLocalMinute: number;
    label: string;
    completedCountBefore: number;
  },
  localDate: Pick<ZonedDateParts, "year" | "month" | "day">,
  now: Date,
): LifeOpsOccurrence {
  const cadence = definition.cadence;
  if (cadence.kind !== "interval") {
    throw new Error("buildIntervalOccurrence requires interval cadence");
  }
  const scheduledDayOffset = Math.floor(args.scheduledLocalMinute / (24 * 60));
  const scheduledMinuteOfDay = args.scheduledLocalMinute % (24 * 60);
  const scheduledDate = addDaysToLocalDate(localDate, scheduledDayOffset);
  const scheduledLocal = {
    ...scheduledDate,
    hour: Math.floor(scheduledMinuteOfDay / 60),
    minute: scheduledMinuteOfDay % 60,
    second: 0,
  } satisfies ZonedDateParts;
  const scheduledAt = buildUtcDateFromLocalParts(
    definition.timezone,
    scheduledLocal,
  );
  const dueAt = scheduledAt;
  const leadMinutes = resolveLeadMinutes(cadence);
  const durationMinutes = Math.max(
    1,
    cadence.durationMinutes ?? Math.min(cadence.everyMinutes, 60),
  );
  const lagMinutes = Math.max(resolveLagMinutes(cadence), durationMinutes);
  const relevanceStartAt = addMinutes(scheduledAt, -leadMinutes);
  const relevanceEndAt = addMinutes(scheduledAt, lagMinutes);
  const occurrenceKey = buildOccurrenceKey(
    "interval",
    args.localDateKey,
    args.intervalKey,
  );
  return {
    id: existing?.id ?? crypto.randomUUID(),
    agentId: definition.agentId,
    domain: definition.domain,
    subjectType: definition.subjectType,
    subjectId: definition.subjectId,
    visibilityScope: definition.visibilityScope,
    contextPolicy: definition.contextPolicy,
    definitionId: definition.id,
    occurrenceKey,
    scheduledAt: scheduledAt.toISOString(),
    dueAt: dueAt.toISOString(),
    relevanceStartAt: relevanceStartAt.toISOString(),
    relevanceEndAt: relevanceEndAt.toISOString(),
    windowName: args.label,
    state: resolveOccurrenceState(
      existing?.state,
      relevanceStartAt,
      relevanceEndAt,
      now,
      existing?.snoozedUntil ?? null,
    ),
    snoozedUntil: existing?.snoozedUntil ?? null,
    completionPayload: existing?.completionPayload ?? null,
    derivedTarget: deriveTarget(
      definition.progressionRule,
      args.completedCountBefore,
    ),
    metadata: {
      ...(existing?.metadata ?? {}),
      localDateKey: args.localDateKey,
      cadenceKind: definition.cadence.kind,
      intervalKey: args.intervalKey,
    },
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function buildOnceOccurrence(
  definition: LifeOpsTaskDefinition,
  existing: LifeOpsOccurrence | undefined,
  completedCountBefore: number,
  now: Date,
): LifeOpsOccurrence {
  const cadence = definition.cadence;
  if (cadence.kind !== "once") {
    throw new Error("buildOnceOccurrence requires once cadence");
  }
  const dueAt = new Date(cadence.dueAt);
  const relevanceStartAt = addMinutes(dueAt, -resolveLeadMinutes(cadence));
  const relevanceEndAt = addMinutes(dueAt, resolveLagMinutes(cadence));
  const dueLocalDate = getZonedDateParts(dueAt, definition.timezone);
  const localDateKey = getLocalDateKey(dueLocalDate);
  return {
    id: existing?.id ?? crypto.randomUUID(),
    agentId: definition.agentId,
    domain: definition.domain,
    subjectType: definition.subjectType,
    subjectId: definition.subjectId,
    visibilityScope: definition.visibilityScope,
    contextPolicy: definition.contextPolicy,
    definitionId: definition.id,
    occurrenceKey: `once:${dueAt.toISOString()}`,
    scheduledAt: dueAt.toISOString(),
    dueAt: dueAt.toISOString(),
    relevanceStartAt: relevanceStartAt.toISOString(),
    relevanceEndAt: relevanceEndAt.toISOString(),
    windowName: null,
    state: resolveOccurrenceState(
      existing?.state,
      relevanceStartAt,
      relevanceEndAt,
      now,
      existing?.snoozedUntil ?? null,
    ),
    snoozedUntil: existing?.snoozedUntil ?? null,
    completionPayload: existing?.completionPayload ?? null,
    derivedTarget: deriveTarget(
      definition.progressionRule,
      completedCountBefore,
    ),
    metadata: {
      ...(existing?.metadata ?? {}),
      localDateKey,
      cadenceKind: cadence.kind,
    },
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function countCompletedBefore(
  existingOccurrences: LifeOpsOccurrence[],
  occurrenceStartAt: Date,
): number {
  return existingOccurrences.filter((occurrence) => {
    if (occurrence.state !== "completed") return false;
    return (
      new Date(occurrence.relevanceStartAt).getTime() <
      occurrenceStartAt.getTime()
    );
  }).length;
}

export function materializeDefinitionOccurrences(
  definition: LifeOpsTaskDefinition,
  existingOccurrences: LifeOpsOccurrence[],
  options: MaterializeDefinitionOccurrencesOptions = {},
): LifeOpsOccurrence[] {
  const now = options.now ?? new Date();
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const lookaheadDays = options.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS;
  const windowPolicy = normalizeWindowPolicy(
    definition.windowPolicy,
    definition.timezone,
  );
  const windowMap = new Map<string, LifeOpsTimeWindowDefinition>();
  for (const window of windowPolicy.windows) {
    windowMap.set(window.name, window);
  }
  const existingByKey = new Map(
    existingOccurrences.map((occurrence) => [
      occurrence.occurrenceKey,
      occurrence,
    ]),
  );
  const materialized: LifeOpsOccurrence[] = [];

  if (definition.cadence.kind === "once") {
    const occurrence = buildOnceOccurrence(
      definition,
      existingByKey.get(
        `once:${new Date(definition.cadence.dueAt).toISOString()}`,
      ),
      countCompletedBefore(
        existingOccurrences,
        new Date(definition.cadence.dueAt),
      ),
      now,
    );
    materialized.push(occurrence);
    return materialized;
  }

  const localToday = getZonedDateParts(now, definition.timezone);
  const anchorDate = {
    year: localToday.year,
    month: localToday.month,
    day: localToday.day,
  };

  for (let offset = -lookbackDays; offset <= lookaheadDays; offset += 1) {
    const localDate = addDaysToLocalDate(anchorDate, offset);
    const localDateKey = getLocalDateKey(localDate);

    if (definition.cadence.kind === "weekly") {
      const weekday = getWeekdayForLocalDate(localDate);
      if (!definition.cadence.weekdays.includes(weekday)) {
        continue;
      }
      for (const windowName of getCadenceWindows(definition.cadence)) {
        const window = windowMap.get(windowName);
        if (!window) continue;
        const scheduledLocal = {
          ...localDate,
          hour: Math.floor((window.startMinute % (24 * 60)) / 60),
          minute: window.startMinute % 60,
          second: 0,
        } satisfies ZonedDateParts;
        const scheduledAt = buildUtcDateFromLocalParts(
          definition.timezone,
          scheduledLocal,
        );
        const completedCountBefore = countCompletedBefore(
          existingOccurrences,
          scheduledAt,
        );
        materialized.push(
          buildWindowOccurrence(
            definition,
            existingByKey.get(
              buildOccurrenceKey("weekly", localDateKey, window.name),
            ),
            window,
            localDate,
            localDateKey,
            completedCountBefore,
            "weekly",
            now,
          ),
        );
      }
      continue;
    }

    if (definition.cadence.kind === "times_per_day") {
      for (const slot of definition.cadence.slots) {
        const scheduledLocal = {
          ...localDate,
          hour: Math.floor(slot.minuteOfDay / 60),
          minute: slot.minuteOfDay % 60,
          second: 0,
        } satisfies ZonedDateParts;
        const scheduledAt = buildUtcDateFromLocalParts(
          definition.timezone,
          scheduledLocal,
        );
        const completedCountBefore = countCompletedBefore(
          existingOccurrences,
          scheduledAt,
        );
        materialized.push(
          buildSlotOccurrence(
            definition,
            existingByKey.get(
              buildOccurrenceKey("slot", localDateKey, slot.key),
            ),
            slot,
            localDate,
            localDateKey,
            completedCountBefore,
            now,
          ),
        );
      }
      continue;
    }

    if (definition.cadence.kind === "interval") {
      const windows = getCadenceWindows(definition.cadence)
        .map((windowName) => windowMap.get(windowName))
        .filter((window): window is LifeOpsTimeWindowDefinition =>
          Boolean(window),
        )
        .sort((left, right) => left.startMinute - right.startMinute);
      let occurrencesGenerated = 0;
      for (const window of windows) {
        const anchorMinute =
          definition.cadence.startMinuteOfDay ?? window.startMinute;
        const everyMinutes = definition.cadence.everyMinutes;
        const intervalStart =
          anchorMinute >= window.startMinute
            ? anchorMinute
            : anchorMinute +
              Math.ceil((window.startMinute - anchorMinute) / everyMinutes) *
                everyMinutes;
        for (
          let minuteCursor = intervalStart;
          minuteCursor < window.endMinute;
          minuteCursor += everyMinutes
        ) {
          if (
            typeof definition.cadence.maxOccurrencesPerDay === "number" &&
            occurrencesGenerated >= definition.cadence.maxOccurrencesPerDay
          ) {
            break;
          }
          const scheduledDayOffset = Math.floor(minuteCursor / (24 * 60));
          const scheduledMinuteOfDay = minuteCursor % (24 * 60);
          const scheduledDate = addDaysToLocalDate(
            localDate,
            scheduledDayOffset,
          );
          const scheduledLocal = {
            ...scheduledDate,
            hour: Math.floor(scheduledMinuteOfDay / 60),
            minute: scheduledMinuteOfDay % 60,
            second: 0,
          } satisfies ZonedDateParts;
          const scheduledAt = buildUtcDateFromLocalParts(
            definition.timezone,
            scheduledLocal,
          );
          const completedCountBefore = countCompletedBefore(
            existingOccurrences,
            scheduledAt,
          );
          const intervalKey = `${window.name}:${minuteCursor}`;
          materialized.push(
            buildIntervalOccurrence(
              definition,
              existingByKey.get(
                buildOccurrenceKey("interval", localDateKey, intervalKey),
              ),
              {
                localDateKey,
                intervalKey,
                scheduledLocalMinute: minuteCursor,
                label: window.label,
                completedCountBefore,
              },
              localDate,
              now,
            ),
          );
          occurrencesGenerated += 1;
        }
        if (
          typeof definition.cadence.maxOccurrencesPerDay === "number" &&
          occurrencesGenerated >= definition.cadence.maxOccurrencesPerDay
        ) {
          break;
        }
      }
      continue;
    }

    for (const windowName of getCadenceWindows(definition.cadence)) {
      const window = windowMap.get(windowName);
      if (!window) continue;
      const scheduledLocal = {
        ...localDate,
        hour: Math.floor((window.startMinute % (24 * 60)) / 60),
        minute: window.startMinute % 60,
        second: 0,
      } satisfies ZonedDateParts;
      const scheduledAt = buildUtcDateFromLocalParts(
        definition.timezone,
        scheduledLocal,
      );
      const completedCountBefore = countCompletedBefore(
        existingOccurrences,
        scheduledAt,
      );
      materialized.push(
        buildWindowOccurrence(
          definition,
          existingByKey.get(
            buildOccurrenceKey("daily", localDateKey, window.name),
          ),
          window,
          localDate,
          localDateKey,
          completedCountBefore,
          "daily",
          now,
        ),
      );
    }
  }

  materialized.sort(
    (left, right) =>
      new Date(left.relevanceStartAt).getTime() -
      new Date(right.relevanceStartAt).getTime(),
  );
  return materialized;
}

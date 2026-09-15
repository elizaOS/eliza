/** Defines and parses schedule projection records for the LifeOps persistence boundary, preserving public factory and row contracts. */

import crypto from "node:crypto";
import type {
  LifeOpsScheduleMergedState,
  LifeOpsScheduleObservation,
} from "@elizaos/plugin-elizacloud/cloud/lifeops-schedule-sync-contracts";
import type {
  LifeOpsAwakeProbability,
  LifeOpsAwakeProbabilityContributor,
  LifeOpsCircadianRuleFiring,
  LifeOpsCircadianState,
  LifeOpsOccurrence,
  LifeOpsOccurrenceView,
  LifeOpsPersonalBaseline,
  LifeOpsScheduleInsight,
  LifeOpsScheduleMealInsight,
  LifeOpsScheduleRegularity,
  LifeOpsTaskDefinition,
  LifeOpsUnclearReason,
} from "../../contracts/index.js";
import { refreshLifeOpsRelativeTime } from "../relative-time.js";
import {
  parseJsonArray,
  parseJsonRecord,
  parseJsonValue,
  sqlQuote,
  toNumber,
  toText,
} from "../sql.js";
import { isoNow, parseOwnershipFields } from "./record-values.js";

export interface LifeOpsScheduleInsightRecord extends LifeOpsScheduleInsight {
  id: string;
  agentId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsScheduleObservationRecord
  extends LifeOpsScheduleObservation {}

export interface LifeOpsScheduleMergedStateRecord
  extends LifeOpsScheduleMergedState {}

/**
 * Domain and owner-identity scope for definition reads and mutations. When
 * supplied, every predicate binds `domain + subject_type + subject_id`
 * alongside `agent_id` so neither a cross-domain nor cross-subject row can be
 * read or mutated under the same agent.
 */
export type LifeOpsDefinitionScope = {
  domain: LifeOpsTaskDefinition["domain"];
  subjectType: LifeOpsTaskDefinition["subjectType"];
  subjectId: string;
};

export function definitionScopePredicate(
  scope?: LifeOpsDefinitionScope,
  tableAlias?: string,
): string {
  if (!scope) return "";
  const prefix = tableAlias ? `${tableAlias}.` : "";
  return `
          AND ${prefix}domain = ${sqlQuote(scope.domain)}
          AND ${prefix}subject_type = ${sqlQuote(scope.subjectType)}
          AND ${prefix}subject_id = ${sqlQuote(scope.subjectId)}`;
}

export function definitionScopeSetPredicate(
  scopes?: readonly LifeOpsDefinitionScope[],
  tableAlias = "definition",
): string {
  if (scopes === undefined) return "";
  if (scopes.length === 0) return " AND FALSE";
  const clauses = scopes.map(
    (scope) =>
      `(${tableAlias}.domain = ${sqlQuote(scope.domain)} AND ${tableAlias}.subject_type = ${sqlQuote(scope.subjectType)} AND ${tableAlias}.subject_id = ${sqlQuote(scope.subjectId)})`,
  );
  return ` AND (${clauses.join(" OR ")})`;
}

export function parseTaskDefinition(
  row: Record<string, unknown>,
): LifeOpsTaskDefinition {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ...parseOwnershipFields(row),
    kind: toText(row.kind) as LifeOpsTaskDefinition["kind"],
    title: toText(row.title),
    description: toText(row.description),
    originalIntent: toText(row.original_intent),
    timezone: toText(row.timezone),
    status: toText(row.status) as LifeOpsTaskDefinition["status"],
    priority: toNumber(row.priority, 3),
    cadence: parseJsonValue<LifeOpsTaskDefinition["cadence"]>(
      row.cadence_json,
      { kind: "once", dueAt: "" },
    ),
    windowPolicy: parseJsonValue<LifeOpsTaskDefinition["windowPolicy"]>(
      row.window_policy_json,
      { timezone: "UTC", windows: [] },
    ),
    progressionRule: parseJsonValue<LifeOpsTaskDefinition["progressionRule"]>(
      row.progression_rule_json,
      { kind: "none" },
    ),
    checkInPolicy: row.check_in_policy_json
      ? parseJsonValue<LifeOpsTaskDefinition["checkInPolicy"]>(
          row.check_in_policy_json,
          null,
        )
      : null,
    websiteAccess: row.website_access_json
      ? parseJsonValue<LifeOpsTaskDefinition["websiteAccess"]>(
          row.website_access_json,
          null,
        )
      : null,
    reminderPlanId: row.reminder_plan_id ? toText(row.reminder_plan_id) : null,
    goalId: row.goal_id ? toText(row.goal_id) : null,
    source: toText(row.source),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseOccurrence(
  row: Record<string, unknown>,
): LifeOpsOccurrence {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ...parseOwnershipFields(row),
    definitionId: toText(row.definition_id),
    occurrenceKey: toText(row.occurrence_key),
    scheduledAt: row.scheduled_at ? toText(row.scheduled_at) : null,
    dueAt: row.due_at ? toText(row.due_at) : null,
    relevanceStartAt: toText(row.relevance_start_at),
    relevanceEndAt: toText(row.relevance_end_at),
    windowName: row.window_name ? toText(row.window_name) : null,
    state: toText(row.state) as LifeOpsOccurrence["state"],
    snoozedUntil: row.snoozed_until ? toText(row.snoozed_until) : null,
    completionPayload: row.completion_payload_json
      ? parseJsonRecord(row.completion_payload_json)
      : null,
    derivedTarget: row.derived_target_json
      ? parseJsonRecord(row.derived_target_json)
      : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseOccurrenceView(
  row: Record<string, unknown>,
): LifeOpsOccurrenceView {
  const cadence = parseJsonRecord(
    row.definition_cadence_json,
  ) as LifeOpsOccurrenceView["cadence"];
  const rawProgress = Number(row.progress_completed_count);
  if (cadence.kind === "count_per_day" && !Number.isFinite(rawProgress)) {
    throw new Error(
      `LifeOpsRepository: invalid quota projection for occurrence ${toText(row.id)}`,
    );
  }
  const progress =
    cadence.kind === "count_per_day"
      ? (() => {
          const completedCount = Math.min(
            Math.max(Math.trunc(rawProgress), 0),
            cadence.targetCount,
          );
          return {
            completedCount,
            targetCount: cadence.targetCount,
            remainingCount: Math.max(cadence.targetCount - completedCount, 0),
            unit: cadence.unit,
            perOccurrenceWork: cadence.perOccurrenceWork,
          };
        })()
      : null;
  return {
    ...parseOccurrence(row),
    definitionKind: toText(
      row.definition_kind,
    ) as LifeOpsOccurrenceView["definitionKind"],
    definitionStatus: toText(
      row.definition_status,
    ) as LifeOpsOccurrenceView["definitionStatus"],
    cadence,
    title: toText(row.definition_title),
    description: toText(row.definition_description),
    priority: toNumber(row.definition_priority, 3),
    timezone: toText(row.definition_timezone),
    source: toText(row.definition_source, "manual"),
    goalId: row.definition_goal_id ? toText(row.definition_goal_id) : null,
    progress,
  };
}

export function defaultAwakeProbability(
  computedAt: string,
): LifeOpsAwakeProbability {
  return {
    pAwake: 0,
    pAsleep: 0,
    pUnknown: 1,
    contributingSources: [],
    computedAt,
  };
}

export function parseAwakeProbability(
  value: unknown,
  computedAt: string,
): LifeOpsAwakeProbability {
  if (value === null || value === undefined || value === "") {
    return defaultAwakeProbability(computedAt);
  }
  const record = parseJsonRecord(value);
  const contributors = Array.isArray(record.contributingSources)
    ? record.contributingSources
        .filter(
          (candidate): candidate is Record<string, unknown> =>
            Boolean(candidate) && typeof candidate === "object",
        )
        .map((candidate) => ({
          source: toText(
            candidate.source,
          ) as LifeOpsAwakeProbabilityContributor["source"],
          logLikelihoodRatio: toNumber(candidate.logLikelihoodRatio, 0),
        }))
    : [];
  return {
    pAwake: toNumber(record.pAwake, 0),
    pAsleep: toNumber(record.pAsleep, 0),
    pUnknown: toNumber(record.pUnknown, 1),
    contributingSources: contributors,
    computedAt: toText(record.computedAt, computedAt),
  };
}

export function defaultScheduleRegularity(): LifeOpsScheduleRegularity {
  return {
    sri: 0,
    bedtimeStddevMin: 0,
    wakeStddevMin: 0,
    midSleepStddevMin: 0,
    regularityClass: "insufficient_data",
    sampleCount: 0,
    windowDays: 28,
  };
}

export function parseScheduleRegularity(
  value: unknown,
): LifeOpsScheduleRegularity {
  if (value === null || value === undefined || value === "") {
    return defaultScheduleRegularity();
  }
  const record = parseJsonRecord(value);
  return {
    sri: toNumber(record.sri, 0),
    bedtimeStddevMin: toNumber(record.bedtimeStddevMin, 0),
    wakeStddevMin: toNumber(record.wakeStddevMin, 0),
    midSleepStddevMin: toNumber(record.midSleepStddevMin, 0),
    regularityClass: toText(
      record.regularityClass,
      "insufficient_data",
    ) as LifeOpsScheduleRegularity["regularityClass"],
    sampleCount: toNumber(record.sampleCount, 0),
    windowDays: toNumber(record.windowDays, 28),
  };
}

export function parsePersonalBaseline(
  value: unknown,
): LifeOpsPersonalBaseline | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const record = parseJsonRecord(value);
  if (Object.keys(record).length === 0) {
    return null;
  }
  return {
    medianWakeLocalHour: toNumber(record.medianWakeLocalHour, 0),
    medianBedtimeLocalHour: toNumber(record.medianBedtimeLocalHour, 0),
    medianSleepDurationMin: toNumber(record.medianSleepDurationMin, 0),
    bedtimeStddevMin: toNumber(record.bedtimeStddevMin, 0),
    wakeStddevMin: toNumber(record.wakeStddevMin, 0),
    sampleCount: toNumber(record.sampleCount, 0),
    windowDays: toNumber(record.windowDays, 28),
  };
}

export function parseScheduleObservation(
  row: Record<string, unknown>,
): LifeOpsScheduleObservationRecord {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    origin: toText(row.origin) as LifeOpsScheduleObservationRecord["origin"],
    deviceId: toText(row.device_id),
    deviceKind: toText(
      row.device_kind,
    ) as LifeOpsScheduleObservationRecord["deviceKind"],
    timezone: toText(row.timezone, "UTC"),
    observedAt: toText(row.observed_at),
    windowStartAt: toText(row.window_start_at),
    windowEndAt: row.window_end_at ? toText(row.window_end_at) : null,
    circadianState: toText(row.circadian_state) as LifeOpsCircadianState,
    stateConfidence: toNumber(row.state_confidence, 0),
    uncertaintyReason: row.uncertainty_reason
      ? (toText(row.uncertainty_reason) as LifeOpsUnclearReason)
      : null,
    mealLabel: row.meal_label
      ? (toText(
          row.meal_label,
        ) as LifeOpsScheduleObservationRecord["mealLabel"])
      : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseScheduleMergedState(
  row: Record<string, unknown>,
): LifeOpsScheduleMergedStateRecord {
  const inferredAt = toText(row.inferred_at);
  return refreshLifeOpsRelativeTime(
    {
      id: toText(row.id),
      agentId: toText(row.agent_id),
      scope: toText(row.scope) as LifeOpsScheduleMergedStateRecord["scope"],
      mergedAt: toText(row.merged_at),
      effectiveDayKey: toText(row.effective_day_key),
      localDate: toText(row.local_date),
      timezone: toText(row.timezone, "UTC"),
      inferredAt,
      circadianState: toText(
        row.circadian_state,
        "unclear",
      ) as LifeOpsCircadianState,
      stateConfidence: toNumber(row.state_confidence, 0),
      uncertaintyReason: row.uncertainty_reason
        ? (toText(row.uncertainty_reason) as LifeOpsUnclearReason)
        : null,
      awakeProbability: parseAwakeProbability(
        row.awake_probability_json,
        inferredAt,
      ),
      regularity: parseScheduleRegularity(row.regularity_json),
      baseline: parsePersonalBaseline(row.baseline_json),
      circadianRuleFirings: parseJsonArray<LifeOpsCircadianRuleFiring>(
        row.circadian_rule_firings_json,
      ),
      sleepStatus: toText(
        row.sleep_status,
      ) as LifeOpsScheduleMergedStateRecord["sleepStatus"],
      sleepConfidence: toNumber(row.sleep_confidence, 0),
      currentSleepStartedAt: row.current_sleep_started_at
        ? toText(row.current_sleep_started_at)
        : null,
      lastSleepStartedAt: row.last_sleep_started_at
        ? toText(row.last_sleep_started_at)
        : null,
      lastSleepEndedAt: row.last_sleep_ended_at
        ? toText(row.last_sleep_ended_at)
        : null,
      lastSleepDurationMinutes:
        row.last_sleep_duration_minutes !== null &&
        row.last_sleep_duration_minutes !== undefined &&
        row.last_sleep_duration_minutes !== ""
          ? toNumber(row.last_sleep_duration_minutes, 0)
          : null,
      wakeAt: row.wake_at ? toText(row.wake_at) : null,
      firstActiveAt: row.first_active_at ? toText(row.first_active_at) : null,
      lastActiveAt: row.last_active_at ? toText(row.last_active_at) : null,
      meals: parseJsonArray<LifeOpsScheduleMealInsight>(row.meals_json),
      lastMealAt: row.last_meal_at ? toText(row.last_meal_at) : null,
      nextMealLabel: row.next_meal_label
        ? (toText(
            row.next_meal_label,
          ) as LifeOpsScheduleMergedStateRecord["nextMealLabel"])
        : null,
      nextMealWindowStartAt: row.next_meal_window_start_at
        ? toText(row.next_meal_window_start_at)
        : null,
      nextMealWindowEndAt: row.next_meal_window_end_at
        ? toText(row.next_meal_window_end_at)
        : null,
      nextMealConfidence: toNumber(row.next_meal_confidence, 0),
      observationCount: toNumber(row.observation_count, 0),
      deviceCount: toNumber(row.device_count, 0),
      contributingDeviceKinds: parseJsonArray<
        LifeOpsScheduleMergedStateRecord["contributingDeviceKinds"][number]
      >(row.contributing_device_kinds_json),
      metadata: parseJsonRecord(row.metadata_json),
      createdAt: toText(row.created_at),
      updatedAt: toText(row.updated_at),
    },
    new Date(toText(row.inferred_at, toText(row.updated_at))),
  );
}

export function createLifeOpsTaskDefinition(
  params: Omit<
    LifeOpsTaskDefinition,
    "id" | "createdAt" | "updatedAt" | "checkInPolicy"
  > &
    Pick<Partial<LifeOpsTaskDefinition>, "checkInPolicy">,
): LifeOpsTaskDefinition {
  const timestamp = isoNow();
  return {
    ...params,
    checkInPolicy: params.checkInPolicy ?? null,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

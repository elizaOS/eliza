/** Owns schedule projections persistence for LifeOps. Keeps domain mutations and existing transaction or claim boundaries together. */
import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { ElizaError } from "@elizaos/core";
import type {
  LifeOpsOccurrence,
  LifeOpsOccurrenceView,
  LifeOpsTaskDefinition,
} from "../../contracts/index.js";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  type TransactionalDb,
  withTransaction,
} from "../sql.js";
import { isoNow } from "./record-values.js";
import {
  definitionScopePredicate,
  definitionScopeSetPredicate,
  type LifeOpsDefinitionScope,
  type LifeOpsScheduleInsightRecord,
  type LifeOpsScheduleMergedStateRecord,
  type LifeOpsScheduleObservationRecord,
  parseOccurrence,
  parseOccurrenceView,
  parseScheduleMergedState,
  parseScheduleObservation,
  parseTaskDefinition,
} from "./schedule-projection-records.js";
export class ScheduleProjectionRepository {
  constructor(private readonly runtime: IAgentRuntime) {}

  async createDefinition(definition: LifeOpsTaskDefinition): Promise<void> {
    await this.insertDefinition(definition);
  }

  async updateDefinition(
    definition: LifeOpsTaskDefinition,
    options?: {
      expectedUpdatedAt?: string;
      expectedScope?: LifeOpsDefinitionScope;
    },
  ): Promise<void> {
    const revisionPredicate = options?.expectedUpdatedAt
      ? `
         AND updated_at = ${sqlQuote(options.expectedUpdatedAt)}`
      : "";
    const expectedScope = options?.expectedScope ?? {
      domain: definition.domain,
      subjectType: definition.subjectType,
      subjectId: definition.subjectId,
    };
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_task_definitions
         SET domain = ${sqlQuote(definition.domain)},
             subject_type = ${sqlQuote(definition.subjectType)},
             subject_id = ${sqlQuote(definition.subjectId)},
             visibility_scope = ${sqlQuote(definition.visibilityScope)},
             context_policy = ${sqlQuote(definition.contextPolicy)},
             title = ${sqlQuote(definition.title)},
             description = ${sqlQuote(definition.description)},
             original_intent = ${sqlQuote(definition.originalIntent)},
             timezone = ${sqlQuote(definition.timezone)},
             status = ${sqlQuote(definition.status)},
             priority = ${sqlInteger(definition.priority)},
             cadence_json = ${sqlJson(definition.cadence)},
             window_policy_json = ${sqlJson(definition.windowPolicy)},
             progression_rule_json = ${sqlJson(definition.progressionRule)},
             check_in_policy_json = ${sqlText(
               definition.checkInPolicy
                 ? JSON.stringify(definition.checkInPolicy)
                 : null,
             )},
             website_access_json = ${sqlText(
               definition.websiteAccess
                 ? JSON.stringify(definition.websiteAccess)
                 : null,
             )},
             reminder_plan_id = ${sqlText(definition.reminderPlanId)},
             goal_id = ${sqlText(definition.goalId)},
             source = ${sqlQuote(definition.source)},
             metadata_json = ${sqlJson(definition.metadata)},
             updated_at = ${sqlQuote(definition.updatedAt)}
       WHERE id = ${sqlQuote(definition.id)}
         AND agent_id = ${sqlQuote(definition.agentId)}
         AND domain = ${sqlQuote(expectedScope.domain)}
         AND subject_type = ${sqlQuote(expectedScope.subjectType)}
         AND subject_id = ${sqlQuote(expectedScope.subjectId)}${revisionPredicate}
       RETURNING id`,
    );
    if (rows.length !== 1) {
      throw new ElizaError(
        "[LifeOpsRepository] definition update matched no row for this subject and revision",
        {
          code: "LIFEOPS_DEFINITION_CONFLICT",
          context: {
            definitionId: definition.id,
            agentId: definition.agentId,
            domain: definition.domain,
            subjectType: definition.subjectType,
            expectedDomain: expectedScope.domain,
            expectedSubjectType: expectedScope.subjectType,
            expectedSubjectId: expectedScope.subjectId,
            expectedUpdatedAt: options?.expectedUpdatedAt ?? null,
          },
        },
      );
    }
  }

  async getDefinition(
    agentId: string,
    definitionId: string,
    scope?: LifeOpsDefinitionScope,
  ): Promise<LifeOpsTaskDefinition | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_task_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(definitionId)}${definitionScopePredicate(scope)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseTaskDefinition(row) : null;
  }

  async listDefinitions(
    agentId: string,
    scope?: LifeOpsDefinitionScope,
  ): Promise<LifeOpsTaskDefinition[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_task_definitions
        WHERE agent_id = ${sqlQuote(agentId)}${definitionScopePredicate(scope)}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseTaskDefinition);
  }

  async listActiveDefinitions(
    agentId: string,
    scope?: LifeOpsDefinitionScope,
  ): Promise<LifeOpsTaskDefinition[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_task_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND status = 'active'${definitionScopePredicate(scope)}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseTaskDefinition);
  }

  async deleteDefinition(
    agentId: string,
    definitionId: string,
    options?: {
      scope?: LifeOpsDefinitionScope;
      expectedUpdatedAt?: string;
    },
  ): Promise<void> {
    const revisionPredicate = options?.expectedUpdatedAt
      ? `
          AND updated_at = ${sqlQuote(options.expectedUpdatedAt)}`
      : "";
    const deleted = await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_task_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(definitionId)}${definitionScopePredicate(options?.scope)}${revisionPredicate}
        RETURNING id`,
    );
    if (deleted.length !== 1) {
      throw new ElizaError(
        "[LifeOpsRepository] definition delete matched no row for this subject and revision",
        {
          code: "LIFEOPS_DEFINITION_CONFLICT",
          context: {
            definitionId,
            agentId,
            domain: options?.scope?.domain ?? null,
            subjectType: options?.scope?.subjectType ?? null,
            expectedUpdatedAt: options?.expectedUpdatedAt ?? null,
          },
        },
      );
    }
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_reminders.life_reminder_plans
        WHERE agent_id = ${sqlQuote(agentId)}
          AND owner_type = 'definition'
          AND owner_id = ${sqlQuote(definitionId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_goals.life_goal_links
        WHERE agent_id = ${sqlQuote(agentId)}
          AND linked_type = 'definition'
          AND linked_id = ${sqlQuote(definitionId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_task_occurrences
        WHERE agent_id = ${sqlQuote(agentId)}
          AND definition_id = ${sqlQuote(definitionId)}`,
    );
  }

  async upsertOccurrence(occurrence: LifeOpsOccurrence): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_task_occurrences (
        id, agent_id, domain, subject_type, subject_id, visibility_scope,
        context_policy, definition_id, occurrence_key, scheduled_at, due_at,
        relevance_start_at, relevance_end_at, window_name, state,
        snoozed_until, completion_payload_json, derived_target_json,
        metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(occurrence.id)},
        ${sqlQuote(occurrence.agentId)},
        ${sqlQuote(occurrence.domain)},
        ${sqlQuote(occurrence.subjectType)},
        ${sqlQuote(occurrence.subjectId)},
        ${sqlQuote(occurrence.visibilityScope)},
        ${sqlQuote(occurrence.contextPolicy)},
        ${sqlQuote(occurrence.definitionId)},
        ${sqlQuote(occurrence.occurrenceKey)},
        ${sqlText(occurrence.scheduledAt)},
        ${sqlText(occurrence.dueAt)},
        ${sqlQuote(occurrence.relevanceStartAt)},
        ${sqlQuote(occurrence.relevanceEndAt)},
        ${sqlText(occurrence.windowName)},
        ${sqlQuote(occurrence.state)},
        ${sqlText(occurrence.snoozedUntil)},
        ${occurrence.completionPayload ? sqlJson(occurrence.completionPayload) : "NULL"},
        ${occurrence.derivedTarget ? sqlJson(occurrence.derivedTarget) : "NULL"},
        ${sqlJson(occurrence.metadata)},
        ${sqlQuote(occurrence.createdAt)},
        ${sqlQuote(occurrence.updatedAt)}
      )
      ON CONFLICT(agent_id, definition_id, occurrence_key) DO UPDATE SET
        domain = excluded.domain,
        subject_type = excluded.subject_type,
        subject_id = excluded.subject_id,
        visibility_scope = excluded.visibility_scope,
        context_policy = excluded.context_policy,
        scheduled_at = excluded.scheduled_at,
        due_at = excluded.due_at,
        relevance_start_at = excluded.relevance_start_at,
        relevance_end_at = excluded.relevance_end_at,
        window_name = excluded.window_name,
        -- A re-materialization computed from a snapshot taken before a
        -- concurrent completion must not resurrect the day: when the stored
        -- row is already completed and the incoming row is non-terminal, the
        -- completed state and its payload win. Real terminal transitions go
        -- through completeOccurrenceIfNonTerminal / the skip and expire
        -- writers, which always carry a terminal state here.
        state = CASE
          WHEN life_task_occurrences.state = 'completed'
            AND excluded.state NOT IN ('completed', 'skipped', 'expired', 'muted')
          THEN life_task_occurrences.state
          ELSE excluded.state
        END,
        snoozed_until = CASE
          WHEN life_task_occurrences.state = 'completed'
            AND excluded.state NOT IN ('completed', 'skipped', 'expired', 'muted')
          THEN NULL
          ELSE excluded.snoozed_until
        END,
        completion_payload_json = CASE
          WHEN life_task_occurrences.state = 'completed'
            AND excluded.state NOT IN ('completed', 'skipped', 'expired', 'muted')
          THEN life_task_occurrences.completion_payload_json
          ELSE excluded.completion_payload_json
        END,
        derived_target_json = excluded.derived_target_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listOccurrencesForDefinition(
    agentId: string,
    definitionId: string,
  ): Promise<LifeOpsOccurrence[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_task_occurrences
        WHERE agent_id = ${sqlQuote(agentId)}
          AND definition_id = ${sqlQuote(definitionId)}
        ORDER BY relevance_start_at ASC`,
    );
    return rows.map(parseOccurrence);
  }

  async listOccurrencesForDefinitions(
    agentId: string,
    definitionIds: string[],
  ): Promise<LifeOpsOccurrence[]> {
    if (definitionIds.length === 0) {
      return [];
    }
    const definitionList = definitionIds
      .map((definitionId) => sqlQuote(definitionId))
      .join(", ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_task_occurrences
        WHERE agent_id = ${sqlQuote(agentId)}
          AND definition_id IN (${definitionList})
        ORDER BY definition_id ASC, relevance_start_at ASC`,
    );
    return rows.map(parseOccurrence);
  }

  async getOccurrence(
    agentId: string,
    occurrenceId: string,
    definitionScope?: LifeOpsDefinitionScope,
  ): Promise<LifeOpsOccurrence | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT occurrence.*
         FROM app_lifeops.life_task_occurrences AS occurrence
         JOIN app_lifeops.life_task_definitions AS definition
           ON definition.id = occurrence.definition_id
          AND definition.agent_id = occurrence.agent_id
        WHERE occurrence.agent_id = ${sqlQuote(agentId)}
          AND occurrence.id = ${sqlQuote(occurrenceId)}${definitionScopePredicate(definitionScope, "definition")}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseOccurrence(row) : null;
  }

  async getOccurrenceView(
    agentId: string,
    occurrenceId: string,
    definitionScope?: LifeOpsDefinitionScope,
  ): Promise<LifeOpsOccurrenceView | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT occurrence.*,
              definition.kind AS definition_kind,
              definition.status AS definition_status,
              definition.cadence_json AS definition_cadence_json,
              definition.title AS definition_title,
              definition.description AS definition_description,
              definition.priority AS definition_priority,
              definition.timezone AS definition_timezone,
              definition.source AS definition_source,
              definition.goal_id AS definition_goal_id
              ,(SELECT COALESCE(SUM(progress.quantity), 0)
                  FROM app_lifeops.life_task_progress_events progress
                 WHERE progress.agent_id = occurrence.agent_id
                   AND progress.occurrence_id = occurrence.id) AS progress_completed_count
         FROM app_lifeops.life_task_occurrences AS occurrence
         JOIN app_lifeops.life_task_definitions AS definition
           ON definition.id = occurrence.definition_id
          AND definition.agent_id = occurrence.agent_id
        WHERE occurrence.agent_id = ${sqlQuote(agentId)}
          AND occurrence.id = ${sqlQuote(occurrenceId)}${definitionScopePredicate(definitionScope, "definition")}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseOccurrenceView(row) : null;
  }

  async listOccurrenceViewsForOverview(
    agentId: string,
    horizonIso: string,
    definitionScopes?: readonly LifeOpsDefinitionScope[],
  ): Promise<LifeOpsOccurrenceView[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT occurrence.*,
              definition.kind AS definition_kind,
              definition.status AS definition_status,
              definition.cadence_json AS definition_cadence_json,
              definition.title AS definition_title,
              definition.description AS definition_description,
              definition.priority AS definition_priority,
              definition.timezone AS definition_timezone,
              definition.source AS definition_source,
              definition.goal_id AS definition_goal_id
              ,(SELECT COALESCE(SUM(progress.quantity), 0)
                  FROM app_lifeops.life_task_progress_events progress
                 WHERE progress.agent_id = occurrence.agent_id
                   AND progress.occurrence_id = occurrence.id) AS progress_completed_count
         FROM app_lifeops.life_task_occurrences AS occurrence
         JOIN app_lifeops.life_task_definitions AS definition
           ON definition.id = occurrence.definition_id
          AND definition.agent_id = occurrence.agent_id
        WHERE occurrence.agent_id = ${sqlQuote(agentId)}
          AND definition.status = 'active'${definitionScopeSetPredicate(definitionScopes)}
          AND (
            occurrence.state IN ('visible', 'snoozed')
            OR (
              occurrence.state = 'pending'
              AND occurrence.relevance_start_at <= ${sqlQuote(horizonIso)}
            )
          )
        ORDER BY occurrence.relevance_start_at ASC, definition.priority ASC`,
    );
    return rows.map(parseOccurrenceView);
  }

  async listCompletedOccurrenceViewsSince(
    agentId: string,
    sinceIso: string,
    options: {
      subjectType?: "owner" | "agent";
      definitionScopes?: readonly LifeOpsDefinitionScope[];
      limit?: number;
    } = {},
  ): Promise<LifeOpsOccurrenceView[]> {
    const limit = options.limit ?? 24;
    const subjectFilter = options.subjectType
      ? `AND occurrence.subject_type = ${sqlQuote(options.subjectType)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT occurrence.*,
              definition.kind AS definition_kind,
              definition.status AS definition_status,
              definition.cadence_json AS definition_cadence_json,
              definition.title AS definition_title,
              definition.description AS definition_description,
              definition.priority AS definition_priority,
              definition.timezone AS definition_timezone,
              definition.source AS definition_source,
              definition.goal_id AS definition_goal_id
              ,(SELECT COALESCE(SUM(progress.quantity), 0)
                  FROM app_lifeops.life_task_progress_events progress
                 WHERE progress.agent_id = occurrence.agent_id
                   AND progress.occurrence_id = occurrence.id) AS progress_completed_count
         FROM app_lifeops.life_task_occurrences AS occurrence
         JOIN app_lifeops.life_task_definitions AS definition
           ON definition.id = occurrence.definition_id
          AND definition.agent_id = occurrence.agent_id
        WHERE occurrence.agent_id = ${sqlQuote(agentId)}
          AND occurrence.state = 'completed'
          AND occurrence.updated_at >= ${sqlQuote(sinceIso)}
          ${subjectFilter}${definitionScopeSetPredicate(options.definitionScopes)}
        ORDER BY occurrence.updated_at DESC
        LIMIT ${sqlInteger(limit)}`,
    );
    return rows.map(parseOccurrenceView);
  }

  async updateOccurrence(
    occurrence: LifeOpsOccurrence,
    options?: {
      definitionScope?: LifeOpsDefinitionScope;
      expectedUpdatedAt?: string;
      expectedDefinitionUpdatedAt?: string;
    },
  ): Promise<void> {
    const occurrenceRevisionPredicate = options?.expectedUpdatedAt
      ? `
          AND occurrence.updated_at = ${sqlQuote(options.expectedUpdatedAt)}`
      : "";
    const definitionRevisionPredicate = options?.expectedDefinitionUpdatedAt
      ? `
          AND definition.updated_at = ${sqlQuote(options.expectedDefinitionUpdatedAt)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_task_occurrences AS occurrence
          SET domain = ${sqlQuote(occurrence.domain)},
              subject_type = ${sqlQuote(occurrence.subjectType)},
              subject_id = ${sqlQuote(occurrence.subjectId)},
              visibility_scope = ${sqlQuote(occurrence.visibilityScope)},
              context_policy = ${sqlQuote(occurrence.contextPolicy)},
              scheduled_at = ${sqlText(occurrence.scheduledAt)},
              due_at = ${sqlText(occurrence.dueAt)},
              relevance_start_at = ${sqlQuote(occurrence.relevanceStartAt)},
              relevance_end_at = ${sqlQuote(occurrence.relevanceEndAt)},
              window_name = ${sqlText(occurrence.windowName)},
              state = ${sqlQuote(occurrence.state)},
              snoozed_until = ${sqlText(occurrence.snoozedUntil)},
              completion_payload_json = ${occurrence.completionPayload ? sqlJson(occurrence.completionPayload) : "NULL"},
              derived_target_json = ${occurrence.derivedTarget ? sqlJson(occurrence.derivedTarget) : "NULL"},
              metadata_json = ${sqlJson(occurrence.metadata)},
              updated_at = ${sqlQuote(occurrence.updatedAt)}
         FROM app_lifeops.life_task_definitions AS definition
        WHERE occurrence.id = ${sqlQuote(occurrence.id)}
          AND occurrence.agent_id = ${sqlQuote(occurrence.agentId)}
          AND definition.id = occurrence.definition_id
          AND definition.agent_id = occurrence.agent_id${definitionScopePredicate(options?.definitionScope, "definition")}${occurrenceRevisionPredicate}${definitionRevisionPredicate}
       RETURNING occurrence.id`,
    );
    if (rows.length !== 1) {
      throw new ElizaError(
        "[LifeOpsRepository] occurrence update matched no row for this definition scope and revision",
        {
          code: "LIFEOPS_OCCURRENCE_CONFLICT",
          context: {
            occurrenceId: occurrence.id,
            definitionId: occurrence.definitionId,
            agentId: occurrence.agentId,
            expectedDomain: options?.definitionScope?.domain ?? null,
            expectedSubjectType: options?.definitionScope?.subjectType ?? null,
            expectedSubjectId: options?.definitionScope?.subjectId ?? null,
            expectedUpdatedAt: options?.expectedUpdatedAt ?? null,
            expectedDefinitionUpdatedAt:
              options?.expectedDefinitionUpdatedAt ?? null,
          },
        },
      );
    }
  }

  async completeOccurrenceIfNonTerminal(
    occurrence: LifeOpsOccurrence,
    options?: { definitionScope?: LifeOpsDefinitionScope },
  ): Promise<boolean> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_task_occurrences AS occurrence
          SET state = 'completed',
              snoozed_until = NULL,
              completion_payload_json = ${occurrence.completionPayload ? sqlJson(occurrence.completionPayload) : "NULL"},
              updated_at = ${sqlQuote(occurrence.updatedAt)}
         FROM app_lifeops.life_task_definitions AS definition
        WHERE occurrence.id = ${sqlQuote(occurrence.id)}
          AND occurrence.agent_id = ${sqlQuote(occurrence.agentId)}
          AND definition.id = occurrence.definition_id
          AND definition.agent_id = occurrence.agent_id${definitionScopePredicate(options?.definitionScope, "definition")}
          AND occurrence.state NOT IN ('completed', 'skipped', 'expired', 'muted')
      RETURNING occurrence.id`,
    );
    return rows.length === 1;
  }

  async pruneNonTerminalOccurrences(
    agentId: string,
    definitionId: string,
    keepOccurrenceKeys: string[],
  ): Promise<void> {
    const keepClause =
      keepOccurrenceKeys.length > 0
        ? `AND occurrence_key NOT IN (${keepOccurrenceKeys
            .map((occurrenceKey) => sqlQuote(occurrenceKey))
            .join(", ")})`
        : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_task_occurrences
        WHERE agent_id = ${sqlQuote(agentId)}
          AND definition_id = ${sqlQuote(definitionId)}
          AND state IN ('pending', 'visible', 'snoozed', 'expired')
          ${keepClause}`,
    );
  }

  async upsertScheduleInsight(
    insight: LifeOpsScheduleInsightRecord,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_schedule_insights (
         id, agent_id, effective_day_key, local_date, timezone, inferred_at,
         circadian_state, state_confidence, uncertainty_reason, sleep_status,
         sleep_confidence,
         current_sleep_started_at, last_sleep_started_at, last_sleep_ended_at,
         last_sleep_duration_minutes, wake_at, first_active_at, last_active_at,
         last_meal_at,
         next_meal_label, next_meal_window_start_at, next_meal_window_end_at,
         next_meal_confidence, meals_json, awake_probability_json,
         regularity_json, baseline_json, circadian_rule_firings_json,
         metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(insight.id)},
         ${sqlQuote(insight.agentId)},
         ${sqlQuote(insight.effectiveDayKey)},
         ${sqlQuote(insight.localDate)},
         ${sqlQuote(insight.timezone)},
         ${sqlQuote(insight.inferredAt)},
         ${sqlQuote(insight.circadianState)},
         ${sqlNumber(insight.stateConfidence)},
         ${sqlText(insight.uncertaintyReason)},
         ${sqlQuote(insight.sleepStatus)},
         ${sqlNumber(insight.sleepConfidence)},
         ${sqlText(insight.currentSleepStartedAt)},
         ${sqlText(insight.lastSleepStartedAt)},
         ${sqlText(insight.lastSleepEndedAt)},
         ${sqlInteger(insight.lastSleepDurationMinutes)},
         ${sqlText(insight.wakeAt)},
         ${sqlText(insight.firstActiveAt)},
         ${sqlText(insight.lastActiveAt)},
         ${sqlText(insight.lastMealAt)},
         ${sqlText(insight.nextMealLabel)},
         ${sqlText(insight.nextMealWindowStartAt)},
         ${sqlText(insight.nextMealWindowEndAt)},
         ${sqlNumber(insight.nextMealConfidence)},
         ${sqlJson(insight.meals)},
         ${sqlJson(insight.awakeProbability)},
         ${sqlJson(insight.regularity)},
         ${sqlJson(insight.baseline)},
         ${sqlJson(insight.circadianRuleFirings)},
         ${sqlJson(insight.metadata)},
         ${sqlQuote(insight.createdAt)},
         ${sqlQuote(insight.updatedAt)}
       )
       ON CONFLICT(agent_id, effective_day_key) DO UPDATE SET
         local_date = EXCLUDED.local_date,
         timezone = EXCLUDED.timezone,
         inferred_at = EXCLUDED.inferred_at,
         circadian_state = EXCLUDED.circadian_state,
         state_confidence = EXCLUDED.state_confidence,
         uncertainty_reason = EXCLUDED.uncertainty_reason,
         sleep_status = EXCLUDED.sleep_status,
         sleep_confidence = EXCLUDED.sleep_confidence,
         current_sleep_started_at = EXCLUDED.current_sleep_started_at,
         last_sleep_started_at = EXCLUDED.last_sleep_started_at,
         last_sleep_ended_at = EXCLUDED.last_sleep_ended_at,
         last_sleep_duration_minutes = EXCLUDED.last_sleep_duration_minutes,
         wake_at = EXCLUDED.wake_at,
         first_active_at = EXCLUDED.first_active_at,
         last_active_at = EXCLUDED.last_active_at,
         last_meal_at = EXCLUDED.last_meal_at,
         next_meal_label = EXCLUDED.next_meal_label,
         next_meal_window_start_at = EXCLUDED.next_meal_window_start_at,
         next_meal_window_end_at = EXCLUDED.next_meal_window_end_at,
         next_meal_confidence = EXCLUDED.next_meal_confidence,
         meals_json = EXCLUDED.meals_json,
         awake_probability_json = EXCLUDED.awake_probability_json,
         regularity_json = EXCLUDED.regularity_json,
         baseline_json = EXCLUDED.baseline_json,
         circadian_rule_firings_json = EXCLUDED.circadian_rule_firings_json,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async upsertScheduleObservation(
    observation: LifeOpsScheduleObservationRecord,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_schedule_observations (
         id, agent_id, origin, device_id, device_kind, timezone, observed_at,
         window_start_at, window_end_at, circadian_state, state_confidence,
         uncertainty_reason, meal_label, metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(observation.id)},
         ${sqlQuote(observation.agentId)},
         ${sqlQuote(observation.origin)},
         ${sqlQuote(observation.deviceId)},
         ${sqlQuote(observation.deviceKind)},
         ${sqlQuote(observation.timezone)},
         ${sqlQuote(observation.observedAt)},
         ${sqlQuote(observation.windowStartAt)},
         ${sqlText(observation.windowEndAt)},
         ${sqlQuote(observation.circadianState)},
         ${sqlNumber(observation.stateConfidence)},
         ${sqlText(observation.uncertaintyReason)},
         ${sqlText(observation.mealLabel)},
         ${sqlJson(observation.metadata)},
         ${sqlQuote(observation.createdAt)},
         ${sqlQuote(observation.updatedAt)}
       )
       ON CONFLICT(id) DO UPDATE SET
         observed_at = EXCLUDED.observed_at,
         window_end_at = EXCLUDED.window_end_at,
         circadian_state = EXCLUDED.circadian_state,
         state_confidence = EXCLUDED.state_confidence,
         uncertainty_reason = EXCLUDED.uncertainty_reason,
         meal_label = EXCLUDED.meal_label,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async listScheduleObservations(
    agentId: string,
    sinceAt: string,
    opts?: {
      origin?: LifeOpsScheduleObservationRecord["origin"];
      deviceId?: string;
      limit?: number;
    },
  ): Promise<LifeOpsScheduleObservationRecord[]> {
    const clauses = [
      `agent_id = ${sqlQuote(agentId)}`,
      `observed_at >= ${sqlQuote(sinceAt)}`,
    ];
    if (opts?.origin) {
      clauses.push(`origin = ${sqlQuote(opts.origin)}`);
    }
    if (opts?.deviceId) {
      clauses.push(`device_id = ${sqlQuote(opts.deviceId)}`);
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_schedule_observations
        WHERE ${clauses.join(" AND ")}
        ORDER BY observed_at DESC
        ${limitClause}`,
    );
    return rows.map(parseScheduleObservation);
  }

  async upsertScheduleMergedState(
    state: LifeOpsScheduleMergedStateRecord,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_schedule_merged_states (
         id, agent_id, scope, effective_day_key, local_date, timezone,
         merged_at, inferred_at, circadian_state, state_confidence,
         uncertainty_reason, sleep_status, sleep_confidence,
         current_sleep_started_at, last_sleep_started_at,
         last_sleep_ended_at, last_sleep_duration_minutes,
         wake_at, first_active_at, last_active_at,
         last_meal_at, next_meal_label, next_meal_window_start_at,
         next_meal_window_end_at, next_meal_confidence, meals_json,
         awake_probability_json, regularity_json, baseline_json,
         circadian_rule_firings_json,
         observation_count, device_count, contributing_device_kinds_json,
         metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(state.id)},
         ${sqlQuote(state.agentId)},
         ${sqlQuote(state.scope)},
         ${sqlQuote(state.effectiveDayKey)},
         ${sqlQuote(state.localDate)},
         ${sqlQuote(state.timezone)},
         ${sqlQuote(state.mergedAt)},
         ${sqlQuote(state.inferredAt)},
         ${sqlQuote(state.circadianState)},
         ${sqlNumber(state.stateConfidence)},
         ${sqlText(state.uncertaintyReason)},
         ${sqlQuote(state.sleepStatus)},
         ${sqlNumber(state.sleepConfidence)},
         ${sqlText(state.currentSleepStartedAt)},
         ${sqlText(state.lastSleepStartedAt)},
         ${sqlText(state.lastSleepEndedAt)},
         ${sqlInteger(state.lastSleepDurationMinutes)},
         ${sqlText(state.wakeAt)},
         ${sqlText(state.firstActiveAt)},
         ${sqlText(state.lastActiveAt)},
         ${sqlText(state.lastMealAt)},
         ${sqlText(state.nextMealLabel)},
         ${sqlText(state.nextMealWindowStartAt)},
         ${sqlText(state.nextMealWindowEndAt)},
         ${sqlNumber(state.nextMealConfidence)},
         ${sqlJson(state.meals)},
         ${sqlJson(state.awakeProbability)},
         ${sqlJson(state.regularity)},
         ${state.baseline === null ? "NULL" : sqlJson(state.baseline)},
         ${sqlJson(state.circadianRuleFirings)},
         ${sqlInteger(state.observationCount)},
         ${sqlInteger(state.deviceCount)},
         ${sqlJson(state.contributingDeviceKinds)},
         ${sqlJson(state.metadata)},
         ${sqlQuote(state.createdAt)},
         ${sqlQuote(state.updatedAt)}
       )
       ON CONFLICT(agent_id, scope, timezone) DO UPDATE SET
         effective_day_key = EXCLUDED.effective_day_key,
         local_date = EXCLUDED.local_date,
         merged_at = EXCLUDED.merged_at,
         inferred_at = EXCLUDED.inferred_at,
         circadian_state = EXCLUDED.circadian_state,
         state_confidence = EXCLUDED.state_confidence,
         uncertainty_reason = EXCLUDED.uncertainty_reason,
         sleep_status = EXCLUDED.sleep_status,
         sleep_confidence = EXCLUDED.sleep_confidence,
         current_sleep_started_at = EXCLUDED.current_sleep_started_at,
         last_sleep_started_at = EXCLUDED.last_sleep_started_at,
         last_sleep_ended_at = EXCLUDED.last_sleep_ended_at,
         last_sleep_duration_minutes = EXCLUDED.last_sleep_duration_minutes,
         wake_at = EXCLUDED.wake_at,
         first_active_at = EXCLUDED.first_active_at,
         last_active_at = EXCLUDED.last_active_at,
         last_meal_at = EXCLUDED.last_meal_at,
         next_meal_label = EXCLUDED.next_meal_label,
         next_meal_window_start_at = EXCLUDED.next_meal_window_start_at,
         next_meal_window_end_at = EXCLUDED.next_meal_window_end_at,
         next_meal_confidence = EXCLUDED.next_meal_confidence,
         meals_json = EXCLUDED.meals_json,
         awake_probability_json = EXCLUDED.awake_probability_json,
         regularity_json = EXCLUDED.regularity_json,
         baseline_json = EXCLUDED.baseline_json,
         circadian_rule_firings_json = EXCLUDED.circadian_rule_firings_json,
         observation_count = EXCLUDED.observation_count,
         device_count = EXCLUDED.device_count,
         contributing_device_kinds_json = EXCLUDED.contributing_device_kinds_json,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async getScheduleMergedState(
    agentId: string,
    scope: LifeOpsScheduleMergedStateRecord["scope"],
    timezone: string,
  ): Promise<LifeOpsScheduleMergedStateRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_schedule_merged_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND scope = ${sqlQuote(scope)}
          AND timezone = ${sqlQuote(timezone)}
        LIMIT 1`,
    );
    return rows[0] ? parseScheduleMergedState(rows[0]) : null;
  }

  private async insertDefinition(
    definition: LifeOpsTaskDefinition,
    tx?: TransactionalDb,
  ): Promise<void> {
    const query = `INSERT INTO app_lifeops.life_task_definitions (
        id, agent_id, domain, subject_type, subject_id, visibility_scope,
        context_policy, kind, title, description, original_intent, timezone,
        status, priority, cadence_json, window_policy_json,
        progression_rule_json, check_in_policy_json, website_access_json, reminder_plan_id, goal_id, source,
        metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(definition.id)},
        ${sqlQuote(definition.agentId)},
        ${sqlQuote(definition.domain)},
        ${sqlQuote(definition.subjectType)},
        ${sqlQuote(definition.subjectId)},
        ${sqlQuote(definition.visibilityScope)},
        ${sqlQuote(definition.contextPolicy)},
        ${sqlQuote(definition.kind)},
        ${sqlQuote(definition.title)},
        ${sqlQuote(definition.description)},
        ${sqlQuote(definition.originalIntent)},
        ${sqlQuote(definition.timezone)},
        ${sqlQuote(definition.status)},
        ${sqlInteger(definition.priority)},
        ${sqlJson(definition.cadence)},
        ${sqlJson(definition.windowPolicy)},
        ${sqlJson(definition.progressionRule)},
        ${sqlText(
          definition.checkInPolicy
            ? JSON.stringify(definition.checkInPolicy)
            : null,
        )},
        ${sqlText(
          definition.websiteAccess
            ? JSON.stringify(definition.websiteAccess)
            : null,
        )},
        ${sqlText(definition.reminderPlanId)},
        ${sqlText(definition.goalId)},
        ${sqlQuote(definition.source)},
        ${sqlJson(definition.metadata)},
        ${sqlQuote(definition.createdAt)},
        ${sqlQuote(definition.updatedAt)}
      )`;
    if (tx) await executeRawSqlTx(tx, query);
    else await executeRawSql(this.runtime, query);
  }

  /** Claim identity and create its record atomically before dependent effects. */
  async claimDefinitionCreation(
    definition: LifeOpsTaskDefinition,
    key: string,
    requestJson: string,
  ): Promise<{ definition: LifeOpsTaskDefinition; replayed: boolean }> {
    const claimed = await withTransaction(this.runtime, async (tx) => {
      const rows = await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_audit_events
        (id, agent_id, event_type, owner_type, owner_id, reason, inputs_json, decision_json, actor, created_at, idempotency_key)
        VALUES (${sqlQuote(crypto.randomUUID())}, ${sqlQuote(definition.agentId)}, 'definition_creation_claimed', 'definition',
          ${sqlQuote(definition.id)}, 'creation operation claimed', ${sqlQuote(requestJson)}, '{}', 'agent', ${sqlQuote(isoNow())}, ${sqlQuote(key)})
        ON CONFLICT (agent_id, event_type, idempotency_key) DO NOTHING RETURNING id`,
      );
      if (rows.length === 0) return false;
      await this.insertDefinition(definition, tx);
      return true;
    });
    if (claimed) return { definition, replayed: false };
    const rows = await executeRawSql(
      this.runtime,
      `SELECT owner_id,
      inputs_json::jsonb = ${sqlQuote(requestJson)}::jsonb AS request_matches,
      EXISTS (SELECT 1 FROM app_lifeops.life_audit_events completed
        WHERE completed.agent_id = claim.agent_id AND completed.event_type = 'definition_creation_completed'
          AND completed.idempotency_key = claim.idempotency_key AND completed.owner_id = claim.owner_id) AS completed
      FROM app_lifeops.life_audit_events claim
      WHERE agent_id = ${sqlQuote(definition.agentId)} AND event_type = 'definition_creation_claimed'
        AND idempotency_key = ${sqlQuote(key)}`,
    );
    const row = rows[0];
    if (row?.request_matches !== true) {
      throw new ElizaError(
        "[LifeOpsRepository] Creation key already identifies a different operation; reuse its original request or choose a new key for a new operation.",
        {
          code: "LIFEOPS_DEFINITION_IDEMPOTENCY_CONFLICT",
          context: { agentId: definition.agentId },
        },
      );
    }
    const current = await this.getDefinition(
      definition.agentId,
      toText(row.owner_id),
      definition,
    );
    if (!current)
      throw new ElizaError(
        "[LifeOpsRepository] This creation's record was deleted or is no longer in your scope. Its operation key cannot create another record.",
        {
          code: "LIFEOPS_DEFINITION_CREATION_RESOURCE_UNAVAILABLE",
          context: { agentId: definition.agentId },
        },
      );
    if (row.completed !== true) {
      throw new ElizaError(
        "[LifeOpsRepository] This creation has a persisted record but its dependent effects are not confirmed complete. Reconcile that record before retrying; no new creation was dispatched.",
        {
          code: "LIFEOPS_DEFINITION_CREATION_INCOMPLETE",
          context: { definitionId: current.id, retryable: false },
        },
      );
    }
    return { definition: current, replayed: true };
  }

  /** Append completion only after all existing creation work has succeeded. */
  async completeDefinitionCreation(
    definition: LifeOpsTaskDefinition,
    key: string,
  ): Promise<void> {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_audit_events
      (id, agent_id, event_type, owner_type, owner_id, reason, inputs_json, decision_json, actor, created_at, idempotency_key)
      SELECT ${sqlQuote(crypto.randomUUID())}, definition.agent_id, 'definition_creation_completed', 'definition', definition.id,
        'creation operation completed', '{}', ${sqlJson({ version: definition.updatedAt })}, 'agent', ${sqlQuote(isoNow())}, claim.idempotency_key
      FROM app_lifeops.life_task_definitions definition
      JOIN app_lifeops.life_audit_events claim ON claim.agent_id = definition.agent_id AND claim.owner_id = definition.id
      WHERE definition.agent_id = ${sqlQuote(definition.agentId)} AND definition.id = ${sqlQuote(definition.id)}
        AND claim.event_type = 'definition_creation_claimed' AND claim.idempotency_key = ${sqlQuote(key)}
        ${definitionScopePredicate(definition, "definition")} RETURNING id`,
    );
    if (rows.length !== 1)
      throw new ElizaError(
        "[LifeOpsRepository] Creation scope changed before completion could be recorded; inspect the existing operation.",
        {
          code: "LIFEOPS_DEFINITION_CREATION_COMPLETION_CONFLICT",
          context: { agentId: definition.agentId },
        },
      );
  }

  /** Atomically transition an owner-scoped undated todo and its audit, preserving no-op revisions. */
  async transitionUnscheduledTodo(
    expected: LifeOpsTaskDefinition,
    status: "active" | "completed",
    updatedAt: string,
  ): Promise<{
    definition: LifeOpsTaskDefinition;
    replayed: boolean;
    auditId: string | null;
  }> {
    try {
      return await withTransaction(this.runtime, async (tx) => {
        const rows = await executeRawSqlTx(
          tx,
          `SELECT * FROM app_lifeops.life_task_definitions
        WHERE agent_id = ${sqlQuote(expected.agentId)} AND id = ${sqlQuote(expected.id)}
        ${definitionScopePredicate(expected)} FOR UPDATE`,
        );
        if (rows.length !== 1)
          throw new ElizaError(
            "The todo is no longer available in this owner scope.",
            {
              code: "LIFEOPS_DEFINITION_CONFLICT",
              context: { definitionId: expected.id },
            },
          );
        const current = parseTaskDefinition(rows[0]);
        if (
          current.kind !== "task" ||
          current.cadence.kind !== "unscheduled" ||
          !["active", "completed"].includes(current.status)
        ) {
          throw new ElizaError(
            "Only active or completed undated todos support this transition; scheduled items use their occurrence.",
            {
              code: "LIFEOPS_TODO_TRANSITION_INVALID",
              context: { definitionId: current.id },
            },
          );
        }
        if (current.status === status)
          return { definition: current, replayed: true, auditId: null };
        if (current.updatedAt !== expected.updatedAt)
          throw new ElizaError(
            "The todo changed before this transition; read its current state before retrying.",
            {
              code: "LIFEOPS_DEFINITION_CONFLICT",
              context: { definitionId: current.id },
            },
          );
        const next = { ...current, status, updatedAt };
        const auditId = crypto.randomUUID();
        await executeRawSqlTx(
          tx,
          `UPDATE app_lifeops.life_task_definitions SET status = ${sqlQuote(status)}, updated_at = ${sqlQuote(updatedAt)}
        WHERE agent_id = ${sqlQuote(current.agentId)} AND id = ${sqlQuote(current.id)} ${definitionScopePredicate(current)}`,
        );
        await executeRawSqlTx(
          tx,
          `INSERT INTO app_lifeops.life_audit_events
        (id, agent_id, event_type, owner_type, owner_id, reason, inputs_json, decision_json, actor, created_at)
        VALUES (${sqlQuote(auditId)}, ${sqlQuote(current.agentId)}, ${sqlQuote(status === "completed" ? "definition_completed" : "definition_reopened")}, 'definition', ${sqlQuote(current.id)},
        'owner todo state transition', ${sqlJson({ previousStatus: current.status, previousRevision: current.updatedAt })}, ${sqlJson({ status, version: updatedAt })}, 'agent', ${sqlQuote(updatedAt)})`,
        );
        return { definition: next, replayed: false, auditId };
      });
    } catch (error) {
      // error-policy:J2 Preserve typed transition conflicts and attach context to database failures.
      if (error instanceof ElizaError) throw error;
      throw new ElizaError(
        "The todo state change could not be committed; inspect the current todo before retrying.",
        {
          code: "LIFEOPS_TODO_TRANSITION_FAILED",
          cause: error,
          context: { definitionId: expected.id },
        },
      );
    }
  }
}

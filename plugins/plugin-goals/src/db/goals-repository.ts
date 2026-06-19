/**
 * Raw-SQL repository for the goals back-end.
 *
 * Owns all reads/writes against the goal tables (`life_goal_definitions`,
 * `life_goal_links`), carved out of `@elizaos/plugin-personal-assistant`'s
 * `app_lifeops` schema into this plugin's `app_goals` schema. PA's
 * reminder/scheduling subsystem still reads + writes goal links
 * (`upsertGoalLink` / `deleteGoalLinksForLinked`), but through PA's own
 * repository, whose SQL was repointed to `app_goals` in the same carve — so a
 * single owner backs every reader. The `deleteGoal` cross-schema writes to
 * `app_lifeops.life_task_definitions` (spine FK-nullout) and
 * `app_lifeops.life_audit_events` (audit) stay on `app_lifeops`.
 *
 * SQL execution + value encoding go through the self-contained {@link ./sql.ts}
 * helpers, so this repository has no dependency on plugin-personal-assistant.
 */

import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsActor,
  LifeOpsAuditEventType,
  LifeOpsGoalDefinition,
  LifeOpsGoalLink,
  LifeOpsOwnerType,
} from "@elizaos/shared";
import {
  executeRawSql,
  parseJsonRecord,
  sqlJson,
  sqlQuote,
  toText,
} from "./sql.ts";

function parseOwnershipFields(row: Record<string, unknown>) {
  const subjectType =
    toText(row.subject_type, "owner") === "agent" ? "agent" : "owner";
  return {
    domain:
      toText(
        row.domain,
        subjectType === "agent" ? "agent_ops" : "user_lifeops",
      ) === "agent_ops"
        ? "agent_ops"
        : "user_lifeops",
    subjectType,
    subjectId: toText(row.subject_id, toText(row.agent_id)),
    visibilityScope:
      subjectType === "owner"
        ? "owner_only"
        : toText(row.visibility_scope, "agent_and_admin") === "owner_only"
          ? "owner_only"
          : toText(row.visibility_scope, "agent_and_admin") ===
              "agent_and_admin"
            ? "agent_and_admin"
            : "owner_agent_admin",
    contextPolicy:
      toText(
        row.context_policy,
        subjectType === "agent" ? "never" : "explicit_only",
      ) === "never"
        ? "never"
        : toText(
              row.context_policy,
              subjectType === "agent" ? "never" : "explicit_only",
            ) === "sidebar_only"
          ? "sidebar_only"
          : toText(
                row.context_policy,
                subjectType === "agent" ? "never" : "explicit_only",
              ) === "allowed_in_private_chat"
            ? "allowed_in_private_chat"
            : "explicit_only",
  } as const;
}

function parseGoal(row: Record<string, unknown>): LifeOpsGoalDefinition {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ...parseOwnershipFields(row),
    title: toText(row.title),
    description: toText(row.description),
    cadence: row.cadence_json ? parseJsonRecord(row.cadence_json) : null,
    supportStrategy: parseJsonRecord(row.support_strategy_json),
    successCriteria: parseJsonRecord(row.success_criteria_json),
    status: toText(row.status) as LifeOpsGoalDefinition["status"],
    reviewState: toText(
      row.review_state,
    ) as LifeOpsGoalDefinition["reviewState"],
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseGoalLink(row: Record<string, unknown>): LifeOpsGoalLink {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    goalId: toText(row.goal_id),
    linkedType: toText(row.linked_type) as LifeOpsGoalLink["linkedType"],
    linkedId: toText(row.linked_id),
    createdAt: toText(row.created_at),
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Build a fully-formed goal definition (assigning id + timestamps). Standalone
 * successor to PA's `createLifeOpsGoalDefinition` factory.
 */
export function createGoalDefinition(
  params: Omit<LifeOpsGoalDefinition, "id" | "createdAt" | "updatedAt">,
): LifeOpsGoalDefinition {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export class GoalsRepository {
  constructor(private readonly runtime: IAgentRuntime) {}

  async createGoal(goal: LifeOpsGoalDefinition): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_goals.life_goal_definitions (
        id, agent_id, domain, subject_type, subject_id, visibility_scope,
        context_policy, title, description, cadence_json, support_strategy_json,
        success_criteria_json, status, review_state, metadata_json,
        created_at, updated_at
      ) VALUES (
        ${sqlQuote(goal.id)},
        ${sqlQuote(goal.agentId)},
        ${sqlQuote(goal.domain)},
        ${sqlQuote(goal.subjectType)},
        ${sqlQuote(goal.subjectId)},
        ${sqlQuote(goal.visibilityScope)},
        ${sqlQuote(goal.contextPolicy)},
        ${sqlQuote(goal.title)},
        ${sqlQuote(goal.description)},
        ${goal.cadence ? sqlJson(goal.cadence) : "NULL"},
        ${sqlJson(goal.supportStrategy)},
        ${sqlJson(goal.successCriteria)},
        ${sqlQuote(goal.status)},
        ${sqlQuote(goal.reviewState)},
        ${sqlJson(goal.metadata)},
        ${sqlQuote(goal.createdAt)},
        ${sqlQuote(goal.updatedAt)}
      )`,
    );
  }

  async updateGoal(goal: LifeOpsGoalDefinition): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_goals.life_goal_definitions
          SET domain = ${sqlQuote(goal.domain)},
              subject_type = ${sqlQuote(goal.subjectType)},
              subject_id = ${sqlQuote(goal.subjectId)},
              visibility_scope = ${sqlQuote(goal.visibilityScope)},
              context_policy = ${sqlQuote(goal.contextPolicy)},
              title = ${sqlQuote(goal.title)},
              description = ${sqlQuote(goal.description)},
              cadence_json = ${goal.cadence ? sqlJson(goal.cadence) : "NULL"},
              support_strategy_json = ${sqlJson(goal.supportStrategy)},
              success_criteria_json = ${sqlJson(goal.successCriteria)},
              status = ${sqlQuote(goal.status)},
              review_state = ${sqlQuote(goal.reviewState)},
              metadata_json = ${sqlJson(goal.metadata)},
              updated_at = ${sqlQuote(goal.updatedAt)}
        WHERE id = ${sqlQuote(goal.id)}
          AND agent_id = ${sqlQuote(goal.agentId)}`,
    );
  }

  async getGoal(
    agentId: string,
    goalId: string,
  ): Promise<LifeOpsGoalDefinition | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_goals.life_goal_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(goalId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseGoal(row) : null;
  }

  async listGoals(agentId: string): Promise<LifeOpsGoalDefinition[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_goals.life_goal_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseGoal);
  }

  async deleteGoal(agentId: string, goalId: string): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_goals.life_goal_links
        WHERE agent_id = ${sqlQuote(agentId)}
          AND goal_id = ${sqlQuote(goalId)}`,
    );
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_task_definitions
         SET goal_id = NULL
       WHERE agent_id = ${sqlQuote(agentId)}
         AND goal_id = ${sqlQuote(goalId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_goals.life_goal_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(goalId)}`,
    );
  }

  async upsertGoalLink(link: LifeOpsGoalLink): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_goals.life_goal_links (
        id, agent_id, goal_id, linked_type, linked_id, created_at
      ) VALUES (
        ${sqlQuote(link.id)},
        ${sqlQuote(link.agentId)},
        ${sqlQuote(link.goalId)},
        ${sqlQuote(link.linkedType)},
        ${sqlQuote(link.linkedId)},
        ${sqlQuote(link.createdAt)}
      )
      ON CONFLICT(agent_id, goal_id, linked_type, linked_id) DO NOTHING`,
    );
  }

  async deleteGoalLinksForLinked(
    agentId: string,
    linkedType: LifeOpsGoalLink["linkedType"],
    linkedId: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_goals.life_goal_links
        WHERE agent_id = ${sqlQuote(agentId)}
          AND linked_type = ${sqlQuote(linkedType)}
          AND linked_id = ${sqlQuote(linkedId)}`,
    );
  }

  async listGoalLinksForGoal(
    agentId: string,
    goalId: string,
  ): Promise<LifeOpsGoalLink[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_goals.life_goal_links
        WHERE agent_id = ${sqlQuote(agentId)}
          AND goal_id = ${sqlQuote(goalId)}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseGoalLink);
  }

  /**
   * Append an audit event into PA's shared `app_lifeops.life_audit_events`
   * table. Used by the standalone goals action's default `recordAudit` hook so
   * goal creates/updates/deletes record exactly where PA records them. When PA
   * is present it injects its own `recordAudit` (with the same SQL) instead.
   */
  async createAuditEvent(event: {
    id: string;
    agentId: string;
    eventType: LifeOpsAuditEventType;
    ownerType: LifeOpsOwnerType;
    ownerId: string;
    reason: string;
    inputs: Record<string, unknown>;
    decision: Record<string, unknown>;
    actor: LifeOpsActor;
    createdAt: string;
  }): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_audit_events (
        id, agent_id, event_type, owner_type, owner_id, reason,
        inputs_json, decision_json, actor, created_at
      ) VALUES (
        ${sqlQuote(event.id)},
        ${sqlQuote(event.agentId)},
        ${sqlQuote(event.eventType)},
        ${sqlQuote(event.ownerType)},
        ${sqlQuote(event.ownerId)},
        ${sqlQuote(event.reason)},
        ${sqlJson(event.inputs)},
        ${sqlJson(event.decision)},
        ${sqlQuote(event.actor)},
        ${sqlQuote(event.createdAt)}
      )
      ON CONFLICT(id) DO NOTHING`,
    );
  }
}

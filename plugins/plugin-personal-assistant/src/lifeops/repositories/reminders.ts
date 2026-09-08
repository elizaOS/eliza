/** Adapts LifeOps reminders persistence to canonical domain records. Preserves existing agent scoping, transaction handles, and conditional mutation contracts. */
import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsReminderAttempt,
  LifeOpsReminderPlan,
} from "../../contracts/index.js";
import {
  executeRawSql,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
} from "../sql.js";
import {
  parseReminderAttempt,
  parseReminderPlan,
  readReminderReviewColumnValues,
} from "./reminder-records.js";
export class ReminderRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async createReminderPlan(plan: LifeOpsReminderPlan): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_reminders.life_reminder_plans (
        id, agent_id, owner_type, owner_id, steps_json,
        mute_policy_json, quiet_hours_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(plan.id)},
        ${sqlQuote(plan.agentId)},
        ${sqlQuote(plan.ownerType)},
        ${sqlQuote(plan.ownerId)},
        ${sqlJson(plan.steps)},
        ${sqlJson(plan.mutePolicy)},
        ${sqlJson(plan.quietHours)},
        ${sqlQuote(plan.createdAt)},
        ${sqlQuote(plan.updatedAt)}
      )`,
    );
  }

  async updateReminderPlan(plan: LifeOpsReminderPlan): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_reminders.life_reminder_plans
          SET steps_json = ${sqlJson(plan.steps)},
              mute_policy_json = ${sqlJson(plan.mutePolicy)},
              quiet_hours_json = ${sqlJson(plan.quietHours)},
              updated_at = ${sqlQuote(plan.updatedAt)}
        WHERE id = ${sqlQuote(plan.id)}
          AND agent_id = ${sqlQuote(plan.agentId)}`,
    );
  }

  async deleteReminderPlan(agentId: string, planId: string): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_reminders.life_reminder_plans
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(planId)}`,
    );
  }

  async getReminderPlan(
    agentId: string,
    planId: string,
  ): Promise<LifeOpsReminderPlan | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_reminders.life_reminder_plans
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(planId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseReminderPlan(row) : null;
  }

  async listReminderPlansForOwners(
    agentId: string,
    ownerType: string,
    ownerIds: string[],
  ): Promise<LifeOpsReminderPlan[]> {
    if (ownerIds.length === 0) return [];
    const ownerList = ownerIds.map((ownerId) => sqlQuote(ownerId)).join(", ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_reminders.life_reminder_plans
        WHERE agent_id = ${sqlQuote(agentId)}
          AND owner_type = ${sqlQuote(ownerType)}
          AND owner_id IN (${ownerList})`,
    );
    return rows.map(parseReminderPlan);
  }

  async createReminderAttempt(attempt: LifeOpsReminderAttempt): Promise<void> {
    const metadataReviewColumns = readReminderReviewColumnValues(
      attempt.deliveryMetadata,
    );
    const reviewAt = attempt.reviewAt ?? metadataReviewColumns.reviewAt;
    const reviewStatus =
      attempt.reviewStatus ?? metadataReviewColumns.reviewStatus;
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_reminders.life_reminder_attempts (
        id, agent_id, plan_id, owner_type, owner_id, occurrence_id,
        channel, step_index, scheduled_for, attempted_at, outcome,
        connector_ref, delivery_metadata_json, review_at, review_status
      ) VALUES (
        ${sqlQuote(attempt.id)},
        ${sqlQuote(attempt.agentId)},
        ${sqlQuote(attempt.planId)},
        ${sqlQuote(attempt.ownerType)},
        ${sqlQuote(attempt.ownerId)},
        ${sqlText(attempt.occurrenceId)},
        ${sqlQuote(attempt.channel)},
        ${sqlInteger(attempt.stepIndex)},
        ${sqlQuote(attempt.scheduledFor)},
        ${sqlText(attempt.attemptedAt)},
        ${sqlQuote(attempt.outcome)},
        ${sqlText(attempt.connectorRef)},
        ${sqlJson(attempt.deliveryMetadata)},
        ${sqlText(reviewAt)},
        ${sqlText(reviewStatus)}
      )`,
    );
  }

  async listReminderAttempts(
    agentId: string,
    options?: {
      ownerType?: LifeOpsReminderAttempt["ownerType"];
      ownerId?: string;
      planId?: string;
    },
  ): Promise<LifeOpsReminderAttempt[]> {
    const ownerTypeClause = options?.ownerType
      ? `AND owner_type = ${sqlQuote(options.ownerType)}`
      : "";
    const ownerIdClause = options?.ownerId
      ? `AND owner_id = ${sqlQuote(options.ownerId)}`
      : "";
    const planIdClause = options?.planId
      ? `AND plan_id = ${sqlQuote(options.planId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_reminders.life_reminder_attempts
        WHERE agent_id = ${sqlQuote(agentId)}
          ${ownerTypeClause}
          ${ownerIdClause}
          ${planIdClause}
        ORDER BY scheduled_for ASC, step_index ASC, attempted_at ASC`,
    );
    return rows.map(parseReminderAttempt);
  }

  async listDueReminderReviewAttempts(
    agentId: string,
    nowIso: string,
    limit = 50,
  ): Promise<LifeOpsReminderAttempt[]> {
    const normalizedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_reminders.life_reminder_attempts
        WHERE agent_id = ${sqlQuote(agentId)}
          AND attempted_at IS NOT NULL
          AND outcome IN ('delivered', 'delivered_read', 'delivered_unread')
          AND review_at IS NOT NULL
          AND review_at <= ${sqlQuote(nowIso)}
          AND COALESCE(review_status, '') NOT IN ('resolved', 'escalated', 'clarification_requested')
          AND (review_next_retry_at IS NULL OR review_next_retry_at <= ${sqlQuote(nowIso)})
        ORDER BY review_at ASC, attempted_at ASC
        LIMIT ${sqlInteger(normalizedLimit)}`,
    );
    return rows
      .map(parseReminderAttempt)
      .filter((attempt) => {
        if (!attempt.reviewAt || attempt.reviewAt > nowIso) {
          return false;
        }
        return (
          attempt.reviewStatus !== "resolved" &&
          attempt.reviewStatus !== "escalated" &&
          attempt.reviewStatus !== "clarification_requested"
        );
      })
      .sort((left, right) => {
        const leftReviewAt = left.reviewAt ?? "";
        const rightReviewAt = right.reviewAt ?? "";
        const reviewDelta = leftReviewAt.localeCompare(rightReviewAt);
        if (reviewDelta !== 0) {
          return reviewDelta;
        }
        return (left.attemptedAt ?? "").localeCompare(right.attemptedAt ?? "");
      })
      .slice(0, normalizedLimit);
  }

  async claimDueReminderReviewAttempts(
    agentId: string,
    nowIso: string,
    limit = 50,
    claimedBy = crypto.randomUUID(),
  ): Promise<LifeOpsReminderAttempt[]> {
    const normalizedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_reminders.life_reminder_attempts
          SET review_claimed_at = ${sqlQuote(nowIso)},
              review_claimed_by = ${sqlQuote(claimedBy)},
              review_attempt_count = COALESCE(review_attempt_count, 0) + 1
        WHERE id IN (
          SELECT id
            FROM app_reminders.life_reminder_attempts
           WHERE agent_id = ${sqlQuote(agentId)}
             AND attempted_at IS NOT NULL
             AND outcome IN ('delivered', 'delivered_read', 'delivered_unread')
             AND review_at IS NOT NULL
             AND review_at <= ${sqlQuote(nowIso)}
             AND COALESCE(review_status, '') NOT IN ('resolved', 'escalated', 'clarification_requested')
             AND (review_next_retry_at IS NULL OR review_next_retry_at <= ${sqlQuote(nowIso)})
             AND (
               review_claimed_at IS NULL OR
               review_claimed_at <= ${sqlQuote(new Date(Date.parse(nowIso) - 5 * 60_000).toISOString())}
             )
           ORDER BY review_at ASC, attempted_at ASC
           LIMIT ${sqlInteger(normalizedLimit)}
        )
        RETURNING *`,
    );
    return rows.map(parseReminderAttempt);
  }

  async updateReminderAttemptOutcome(
    id: string,
    outcome: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (metadata && Object.keys(metadata).length > 0) {
      const reviewColumns = readReminderReviewColumnValues(metadata);
      const reviewColumnAssignments: string[] = [];
      if (reviewColumns.reviewAt !== null) {
        reviewColumnAssignments.push(
          `review_at = ${sqlText(reviewColumns.reviewAt)}`,
        );
      }
      if (reviewColumns.reviewStatus !== null) {
        reviewColumnAssignments.push(
          `review_status = ${sqlText(reviewColumns.reviewStatus)}`,
        );
      }
      await executeRawSql(
        this.runtime,
        `UPDATE app_reminders.life_reminder_attempts
            SET outcome = ${sqlQuote(outcome)},
                delivery_metadata_json = delivery_metadata_json::jsonb || ${sqlJson(metadata)}::jsonb
                ${
                  reviewColumnAssignments.length > 0
                    ? `, ${reviewColumnAssignments.join(", ")}`
                    : ""
                }
          WHERE id = ${sqlQuote(id)}`,
      );
    } else {
      await executeRawSql(
        this.runtime,
        `UPDATE app_reminders.life_reminder_attempts
            SET outcome = ${sqlQuote(outcome)}
          WHERE id = ${sqlQuote(id)}`,
      );
    }
  }
}

/** Owns escalation persistence for LifeOps. Keeps domain mutations and existing transaction or claim boundaries together. */
import type { IAgentRuntime } from "@elizaos/core";
import {
  executeRawSql,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
} from "../sql.js";
import {
  type LifeOpsEscalationStateRow,
  parseEscalationStateRow,
} from "./escalation-records.js";
import { isoNow } from "./record-values.js";
export class EscalationRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async upsertEscalationState(state: {
    id: string;
    agentId: string;
    reason: string;
    text: string;
    currentStep: number;
    channelsSent: string[];
    startedAt: string;
    lastSentAt: string;
    resolved: boolean;
    resolvedAt?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const now = isoNow();
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_reminders.life_escalation_states (
        id, agent_id, reason, text, current_step,
        channels_sent_json, started_at, last_sent_at,
        resolved, resolved_at, metadata_json,
        created_at, updated_at
      ) VALUES (
        ${sqlQuote(state.id)},
        ${sqlQuote(state.agentId)},
        ${sqlQuote(state.reason)},
        ${sqlQuote(state.text)},
        ${sqlInteger(state.currentStep)},
        ${sqlJson(state.channelsSent)},
        ${sqlQuote(state.startedAt)},
        ${sqlQuote(state.lastSentAt)},
        ${sqlBoolean(state.resolved)},
        ${sqlText(state.resolvedAt)},
        ${sqlJson(state.metadata ?? {})},
        ${sqlQuote(now)},
        ${sqlQuote(now)}
      )
      ON CONFLICT(id) DO UPDATE SET
        reason = excluded.reason,
        text = excluded.text,
        current_step = excluded.current_step,
        channels_sent_json = excluded.channels_sent_json,
        last_sent_at = excluded.last_sent_at,
        resolved = excluded.resolved,
        resolved_at = excluded.resolved_at,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async getActiveEscalationState(
    agentId: string,
  ): Promise<LifeOpsEscalationStateRow | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_reminders.life_escalation_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND resolved = FALSE
        ORDER BY started_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseEscalationStateRow(row) : null;
  }

  async resolveEscalationState(id: string, resolvedAt: string): Promise<void> {
    const now = isoNow();
    await executeRawSql(
      this.runtime,
      `UPDATE app_reminders.life_escalation_states
         SET resolved = TRUE,
             resolved_at = ${sqlQuote(resolvedAt)},
             updated_at = ${sqlQuote(now)}
       WHERE id = ${sqlQuote(id)}`,
    );
  }

  async listRecentEscalationStates(
    agentId: string,
    limit = 10,
  ): Promise<LifeOpsEscalationStateRow[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_reminders.life_escalation_states
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY started_at DESC
        LIMIT ${sqlInteger(limit)}`,
    );
    return rows.map(parseEscalationStateRow);
  }

  async deleteAllEscalationStates(agentId: string): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_reminders.life_escalation_states
        WHERE agent_id = ${sqlQuote(agentId)}`,
    );
  }
}

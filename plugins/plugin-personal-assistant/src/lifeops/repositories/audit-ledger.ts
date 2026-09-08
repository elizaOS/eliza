/** Owns audit ledger persistence for LifeOps. Keeps domain mutations and existing transaction or claim boundaries together. */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsAuditEvent,
  LifeOpsProgressEvent,
  LifeOpsRelationshipInteraction,
} from "../../contracts/index.js";
import type {
  LifeOpsCommitmentLedgerRecord,
  LifeOpsCommitmentSource,
  LifeOpsCommitmentStatus,
} from "../commitments/index.js";
import type { LifeOpsDelegationContractRecord } from "../delegation-contracts/index.js";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  withTransaction,
} from "../sql.js";
import {
  parseAuditEvent,
  parseCommitmentLedgerRecord,
  parseDelegationContractRecord,
} from "./audit-ledger-records.js";
export class AuditLedgerRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async createAuditEvent(event: LifeOpsAuditEvent): Promise<void> {
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

  async appendProgressEventIfNew(
    event: LifeOpsProgressEvent,
    targetCount: number,
  ): Promise<number | null> {
    return withTransaction(this.runtime, async (tx) => {
      const locked = await executeRawSqlTx(
        tx,
        `SELECT id
           FROM app_lifeops.life_task_occurrences
          WHERE agent_id = ${sqlQuote(event.agentId)}
            AND id = ${sqlQuote(event.occurrenceId)}
          FOR UPDATE`,
      );
      if (locked.length !== 1) return null;
      const duplicate = await executeRawSqlTx(
        tx,
        `SELECT id
           FROM app_lifeops.life_task_progress_events
          WHERE agent_id = ${sqlQuote(event.agentId)}
            AND occurrence_id = ${sqlQuote(event.occurrenceId)}
            AND idempotency_key = ${sqlQuote(event.idempotencyKey)}
          LIMIT 1`,
      );
      if (duplicate.length > 0) return null;
      const totals = await executeRawSqlTx(
        tx,
        `SELECT COALESCE(SUM(quantity), 0) AS total
           FROM app_lifeops.life_task_progress_events
          WHERE agent_id = ${sqlQuote(event.agentId)}
            AND occurrence_id = ${sqlQuote(event.occurrenceId)}`,
      );
      const currentTotal = Number(totals[0]?.total);
      if (!Number.isInteger(currentTotal) || currentTotal < 0) {
        throw new Error(
          `LifeOpsRepository: invalid progress total for occurrence ${event.occurrenceId}`,
        );
      }
      const quantity = Math.min(
        Math.trunc(event.quantity),
        Math.max(Math.trunc(targetCount) - currentTotal, 0),
      );
      if (quantity <= 0) return null;
      const rows = await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_task_progress_events (
          id, agent_id, definition_id, occurrence_id, local_date_key,
          idempotency_key, quantity, unit, note, actor, created_at
        ) VALUES (
          ${sqlQuote(event.id)},
          ${sqlQuote(event.agentId)},
          ${sqlQuote(event.definitionId)},
          ${sqlQuote(event.occurrenceId)},
          ${sqlQuote(event.localDateKey)},
          ${sqlQuote(event.idempotencyKey)},
          ${quantity},
          ${sqlQuote(event.unit)},
          ${event.note === null ? "NULL" : sqlQuote(event.note)},
          ${sqlQuote(event.actor)},
          ${sqlQuote(event.createdAt)}
        )
        ON CONFLICT (agent_id, occurrence_id, idempotency_key) DO NOTHING
        RETURNING quantity`,
      );
      if (rows.length !== 1) return null;
      return quantity;
    });
  }

  async sumProgressEvents(
    agentId: string,
    occurrenceId: string,
  ): Promise<number> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM app_lifeops.life_task_progress_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND occurrence_id = ${sqlQuote(occurrenceId)}`,
    );
    const raw = rows[0]?.total;
    const total = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(total)) {
      throw new Error(
        `LifeOpsRepository: non-numeric progress sum for occurrence ${occurrenceId}`,
      );
    }
    return Math.trunc(total);
  }

  async listProgressEvents(
    agentId: string,
    occurrenceId: string,
  ): Promise<LifeOpsProgressEvent[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_task_progress_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND occurrence_id = ${sqlQuote(occurrenceId)}
        ORDER BY created_at ASC, id ASC`,
    );
    return rows.map((row) => ({
      id: String(row.id),
      agentId: String(row.agent_id),
      definitionId: String(row.definition_id),
      occurrenceId: String(row.occurrence_id),
      localDateKey: String(row.local_date_key),
      idempotencyKey: String(row.idempotency_key),
      quantity: Number(row.quantity),
      unit: String(row.unit),
      note:
        row.note === null || row.note === undefined ? null : String(row.note),
      actor: String(row.actor),
      createdAt: String(row.created_at),
    }));
  }

  async createAuditEventIfNew(event: LifeOpsAuditEvent): Promise<boolean> {
    const rows = await executeRawSql(
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
      ON CONFLICT(id) DO NOTHING
      RETURNING id`,
    );
    return rows.length > 0;
  }

  async listAuditEvents(
    agentId: string,
    ownerType: string,
    ownerId: string,
  ): Promise<LifeOpsAuditEvent[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_audit_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND owner_type = ${sqlQuote(ownerType)}
          AND owner_id = ${sqlQuote(ownerId)}
        ORDER BY created_at DESC`,
    );
    return rows.map(parseAuditEvent);
  }

  async upsertCommitmentLedgerRecord(
    record: LifeOpsCommitmentLedgerRecord,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_commitment_ledger (
        id, agent_id, source, source_key, kind, summary, counterparty, due_at,
        confidence, status, scheduled_task_id, metadata_json, created_at,
        updated_at
      ) VALUES (
        ${sqlQuote(record.id)},
        ${sqlQuote(record.agentId)},
        ${sqlQuote(record.source)},
        ${sqlQuote(record.sourceKey)},
        ${sqlQuote(record.kind)},
        ${sqlQuote(record.summary)},
        ${sqlText(record.counterparty)},
        ${sqlText(record.dueAt)},
        ${sqlNumber(record.confidence)},
        ${sqlQuote(record.status)},
        ${sqlText(record.scheduledTaskId)},
        ${sqlJson(record.metadata)},
        ${sqlQuote(record.createdAt)},
        ${sqlQuote(record.updatedAt)}
      )
      ON CONFLICT(agent_id, source, source_key, kind, summary)
      DO UPDATE SET
        counterparty = EXCLUDED.counterparty,
        due_at = EXCLUDED.due_at,
        confidence = EXCLUDED.confidence,
        status = EXCLUDED.status,
        scheduled_task_id = EXCLUDED.scheduled_task_id,
        metadata_json = EXCLUDED.metadata_json,
        updated_at = EXCLUDED.updated_at`,
    );
  }

  async getCommitmentLedgerRecord(
    agentId: string,
    id: string,
  ): Promise<LifeOpsCommitmentLedgerRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_commitment_ledger
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseCommitmentLedgerRecord(row) : null;
  }

  async listCommitmentLedgerRecords(
    agentId: string,
    filter: {
      statuses?: LifeOpsCommitmentStatus[];
      dueBeforeIso?: string;
      source?: LifeOpsCommitmentSource;
    } = {},
  ): Promise<LifeOpsCommitmentLedgerRecord[]> {
    const clauses = [`agent_id = ${sqlQuote(agentId)}`];
    if (filter.statuses?.length) {
      clauses.push(
        `status IN (${filter.statuses.map((status) => sqlQuote(status)).join(", ")})`,
      );
    }
    if (filter.dueBeforeIso) {
      clauses.push(
        `(due_at IS NULL OR due_at <= ${sqlQuote(filter.dueBeforeIso)})`,
      );
    }
    if (filter.source) {
      clauses.push(`source = ${sqlQuote(filter.source)}`);
    }
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_commitment_ledger
        WHERE ${clauses.join(" AND ")}
        ORDER BY due_at ASC NULLS LAST, created_at ASC`,
    );
    return rows.map(parseCommitmentLedgerRecord);
  }

  async upsertDelegationContract(
    record: LifeOpsDelegationContractRecord,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_delegation_contracts (
        id, agent_id, status, objective, scope_json, autonomy_level,
        tripwires_json, owner_user_id, requested_by, sla_json, state_json,
        metadata_json, created_at, updated_at, expires_at
      ) VALUES (
        ${sqlQuote(record.contractId)},
        ${sqlQuote(record.agentId)},
        ${sqlQuote(record.status)},
        ${sqlQuote(record.objective)},
        ${sqlJson(record.scope)},
        ${sqlQuote(record.autonomyLevel)},
        ${sqlJson(record.tripwires)},
        ${sqlQuote(record.ownerUserId)},
        ${sqlQuote(record.requestedBy)},
        ${record.sla ? sqlJson(record.sla) : "NULL"},
        ${sqlJson(record.state ?? {})},
        ${sqlJson(record.metadata)},
        ${sqlQuote(record.createdAt)},
        ${sqlQuote(record.updatedAt)},
        ${sqlQuote(record.expiresAt)}
      )
      ON CONFLICT(id)
      DO UPDATE SET
        status = EXCLUDED.status,
        objective = EXCLUDED.objective,
        scope_json = EXCLUDED.scope_json,
        autonomy_level = EXCLUDED.autonomy_level,
        tripwires_json = EXCLUDED.tripwires_json,
        owner_user_id = EXCLUDED.owner_user_id,
        requested_by = EXCLUDED.requested_by,
        sla_json = EXCLUDED.sla_json,
        state_json = EXCLUDED.state_json,
        metadata_json = EXCLUDED.metadata_json,
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at`,
    );
  }

  async getDelegationContract(
    agentId: string,
    contractId: string,
  ): Promise<LifeOpsDelegationContractRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_delegation_contracts
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(contractId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseDelegationContractRecord(row) : null;
  }

  async listDelegationContracts(
    agentId: string,
    filter: {
      statuses?: LifeOpsDelegationContractRecord["status"][];
      activeAtIso?: string;
    } = {},
  ): Promise<LifeOpsDelegationContractRecord[]> {
    const clauses = [`agent_id = ${sqlQuote(agentId)}`];
    if (filter.statuses?.length) {
      clauses.push(
        `status IN (${filter.statuses.map((status) => sqlQuote(status)).join(", ")})`,
      );
    }
    if (filter.activeAtIso) {
      clauses.push(`created_at <= ${sqlQuote(filter.activeAtIso)}`);
      clauses.push(`expires_at >= ${sqlQuote(filter.activeAtIso)}`);
    }
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_delegation_contracts
        WHERE ${clauses.join(" AND ")}
        ORDER BY expires_at ASC, created_at ASC`,
    );
    return rows.map(parseDelegationContractRecord);
  }

  async logRelationshipInteraction(
    interaction: LifeOpsRelationshipInteraction,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_relationship_interactions (
         id, agent_id, relationship_id, channel, direction, summary,
         occurred_at, metadata_json, created_at
       ) VALUES (
         ${sqlQuote(interaction.id)},
         ${sqlQuote(interaction.agentId)},
         ${sqlQuote(interaction.relationshipId)},
         ${sqlQuote(interaction.channel)},
         ${sqlQuote(interaction.direction)},
         ${sqlQuote(interaction.summary)},
         ${sqlQuote(interaction.occurredAt)},
         ${sqlJson(interaction.metadata)},
         ${sqlQuote(interaction.createdAt)}
       )`,
    );
  }

  /** Resolve one immutable audit under its complete agent/resource identity. */
  async getAuditEvent(
    agentId: string,
    ownerType: string,
    ownerId: string,
    auditId: string,
  ): Promise<LifeOpsAuditEvent | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_audit_events
      WHERE agent_id = ${sqlQuote(agentId)} AND owner_type = ${sqlQuote(ownerType)}
        AND owner_id = ${sqlQuote(ownerId)} AND id = ${sqlQuote(auditId)}`,
    );
    return rows[0] ? parseAuditEvent(rows[0]) : null;
  }
}

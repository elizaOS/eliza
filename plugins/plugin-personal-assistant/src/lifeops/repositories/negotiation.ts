/** Adapts LifeOps negotiation persistence to canonical domain records. Preserves existing agent scoping, transaction handles, and conditional mutation contracts. */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsSchedulingNegotiation,
  LifeOpsSchedulingProposal,
} from "../../contracts/index.js";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  type TransactionalDb,
} from "../sql.js";
import {
  parseSchedulingNegotiation,
  parseSchedulingProposal,
} from "./negotiation-records.js";
import { isoNow } from "./record-values.js";
export class NegotiationRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async upsertSchedulingNegotiation(
    neg: LifeOpsSchedulingNegotiation,
    tx?: TransactionalDb,
  ): Promise<void> {
    const statement = `INSERT INTO app_lifeops.life_scheduling_negotiations (
         id, agent_id, subject, relationship_id, duration_minutes, timezone,
         state, accepted_proposal_id, started_at, finalized_at, metadata_json,
         created_at, updated_at
       ) VALUES (
         ${sqlQuote(neg.id)},
         ${sqlQuote(neg.agentId)},
         ${sqlQuote(neg.subject)},
         ${sqlText(neg.relationshipId)},
         ${sqlInteger(neg.durationMinutes)},
         ${sqlQuote(neg.timezone)},
         ${sqlQuote(neg.state)},
         ${sqlText(neg.acceptedProposalId)},
         ${sqlQuote(neg.startedAt)},
         ${sqlText(neg.finalizedAt)},
         ${sqlJson(neg.metadata)},
         ${sqlQuote(neg.createdAt)},
         ${sqlQuote(neg.updatedAt)}
       )
       ON CONFLICT (id) DO UPDATE SET
         subject = EXCLUDED.subject,
         relationship_id = EXCLUDED.relationship_id,
         duration_minutes = EXCLUDED.duration_minutes,
         timezone = EXCLUDED.timezone,
         state = EXCLUDED.state,
         accepted_proposal_id = EXCLUDED.accepted_proposal_id,
         finalized_at = EXCLUDED.finalized_at,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`;
    if (tx) {
      await executeRawSqlTx(tx, statement);
    } else {
      await executeRawSql(this.runtime, statement);
    }
  }

  async getSchedulingNegotiation(
    agentId: string,
    id: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingNegotiation | null> {
    const statement = `SELECT *
         FROM app_lifeops.life_scheduling_negotiations
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`;
    const rows = tx
      ? await executeRawSqlTx(tx, statement)
      : await executeRawSql(this.runtime, statement);
    const row = rows[0];
    return row ? parseSchedulingNegotiation(row) : null;
  }

  async listSchedulingNegotiations(
    agentId: string,
    opts?: { state?: string; limit?: number },
  ): Promise<LifeOpsSchedulingNegotiation[]> {
    const clauses = [`agent_id = ${sqlQuote(agentId)}`];
    if (opts?.state) {
      clauses.push(`state = ${sqlQuote(opts.state)}`);
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_scheduling_negotiations
        WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC
        ${limitClause}`,
    );
    return rows.map(parseSchedulingNegotiation);
  }

  async updateSchedulingNegotiationState(
    agentId: string,
    id: string,
    state: string,
    finalizedAt?: string | null,
    tx?: TransactionalDb,
  ): Promise<void> {
    const now = isoNow();
    const finalizedClause =
      finalizedAt === undefined
        ? ""
        : `, finalized_at = ${sqlText(finalizedAt)}`;
    const statement = `UPDATE app_lifeops.life_scheduling_negotiations
          SET state = ${sqlQuote(state)},
              updated_at = ${sqlQuote(now)}${finalizedClause}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}`;
    if (tx) {
      await executeRawSqlTx(tx, statement);
    } else {
      await executeRawSql(this.runtime, statement);
    }
  }

  async upsertSchedulingProposal(
    p: LifeOpsSchedulingProposal,
    tx?: TransactionalDb,
  ): Promise<void> {
    const statement = `INSERT INTO app_lifeops.life_scheduling_proposals (
         id, agent_id, negotiation_id, start_at, end_at, proposed_by, status,
         metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(p.id)},
         ${sqlQuote(p.agentId)},
         ${sqlQuote(p.negotiationId)},
         ${sqlQuote(p.startAt)},
         ${sqlQuote(p.endAt)},
         ${sqlQuote(p.proposedBy)},
         ${sqlQuote(p.status)},
         ${sqlJson(p.metadata)},
         ${sqlQuote(p.createdAt)},
         ${sqlQuote(p.updatedAt)}
       )
       ON CONFLICT (id) DO UPDATE SET
         start_at = EXCLUDED.start_at,
         end_at = EXCLUDED.end_at,
         proposed_by = EXCLUDED.proposed_by,
         status = EXCLUDED.status,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`;
    if (tx) {
      await executeRawSqlTx(tx, statement);
    } else {
      await executeRawSql(this.runtime, statement);
    }
  }

  async getSchedulingProposal(
    agentId: string,
    id: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingProposal | null> {
    const statement = `SELECT *
         FROM app_lifeops.life_scheduling_proposals
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`;
    const rows = tx
      ? await executeRawSqlTx(tx, statement)
      : await executeRawSql(this.runtime, statement);
    const row = rows[0];
    return row ? parseSchedulingProposal(row) : null;
  }

  async listSchedulingProposals(
    agentId: string,
    negotiationId: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingProposal[]> {
    const statement = `SELECT *
         FROM app_lifeops.life_scheduling_proposals
        WHERE agent_id = ${sqlQuote(agentId)}
          AND negotiation_id = ${sqlQuote(negotiationId)}
        ORDER BY created_at ASC`;
    const rows = tx
      ? await executeRawSqlTx(tx, statement)
      : await executeRawSql(this.runtime, statement);
    return rows.map(parseSchedulingProposal);
  }

  async updateSchedulingProposalStatus(
    agentId: string,
    id: string,
    status: string,
    tx?: TransactionalDb,
  ): Promise<void> {
    const now = isoNow();
    const statement = `UPDATE app_lifeops.life_scheduling_proposals
          SET status = ${sqlQuote(status)},
              updated_at = ${sqlQuote(now)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}`;
    if (tx) {
      await executeRawSqlTx(tx, statement);
    } else {
      await executeRawSql(this.runtime, statement);
    }
  }
}

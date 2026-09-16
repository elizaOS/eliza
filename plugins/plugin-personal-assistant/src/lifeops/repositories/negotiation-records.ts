/** Defines and parses negotiation records for the host persistence adapter, preserving canonical domain contracts. */
import type {
  LifeOpsNegotiationState,
  LifeOpsProposalProposer,
  LifeOpsProposalStatus,
  LifeOpsSchedulingNegotiation,
  LifeOpsSchedulingProposal,
} from "../../contracts/index.js";
import { parseJsonRecord, toNumber, toText } from "../sql.js";

export function parseSchedulingNegotiation(
  row: Record<string, unknown>,
): LifeOpsSchedulingNegotiation {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    subject: toText(row.subject),
    relationshipId: row.relationship_id ? toText(row.relationship_id) : null,
    durationMinutes: toNumber(row.duration_minutes, 0),
    timezone: toText(row.timezone, "UTC"),
    state: toText(row.state, "initiated") as LifeOpsNegotiationState,
    acceptedProposalId: row.accepted_proposal_id
      ? toText(row.accepted_proposal_id)
      : null,
    startedAt: toText(row.started_at),
    finalizedAt: row.finalized_at ? toText(row.finalized_at) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseSchedulingProposal(
  row: Record<string, unknown>,
): LifeOpsSchedulingProposal {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    negotiationId: toText(row.negotiation_id),
    startAt: toText(row.start_at),
    endAt: toText(row.end_at),
    proposedBy: toText(row.proposed_by, "agent") as LifeOpsProposalProposer,
    status: toText(row.status, "pending") as LifeOpsProposalStatus,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

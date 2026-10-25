/** Defines and parses escalation records for the LifeOps persistence boundary, preserving public factory and row contracts. */
import {
  parseJsonArray,
  parseJsonRecord,
  toBoolean,
  toNumber,
  toText,
} from "../sql.js";

// ---------------------------------------------------------------------------
// Escalation state row — used by EscalationService for write-through cache
// ---------------------------------------------------------------------------

export interface LifeOpsEscalationStateRow {
  id: string;
  agentId: string;
  reason: string;
  text: string;
  currentStep: number;
  channelsSent: string[];
  startedAt: string;
  lastSentAt: string;
  resolved: boolean;
  resolvedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function parseEscalationStateRow(
  row: Record<string, unknown>,
): LifeOpsEscalationStateRow {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    reason: toText(row.reason),
    text: toText(row.text),
    currentStep: toNumber(row.current_step, 0),
    channelsSent: parseJsonArray<string>(row.channels_sent_json),
    startedAt: toText(row.started_at),
    lastSentAt: toText(row.last_sent_at),
    resolved: toBoolean(row.resolved),
    resolvedAt: row.resolved_at ? toText(row.resolved_at) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

/** Defines and parses audit ledger records for the LifeOps persistence boundary, preserving public factory and row contracts. */

import crypto from "node:crypto";
import type { LifeOpsAuditEvent } from "../../contracts/index.js";
import type {
  LifeOpsCommitmentKind,
  LifeOpsCommitmentLedgerRecord,
  LifeOpsCommitmentSource,
  LifeOpsCommitmentStatus,
} from "../commitments/index.js";
import type {
  DelegationAutonomyLevel,
  DelegationScope,
  DelegationSlaPolicy,
  DelegationTripwire,
  LifeOpsDelegationContractRecord,
} from "../delegation-contracts/index.js";
import { parseJsonRecord, parseJsonValue, toNumber, toText } from "../sql.js";
import { isoNow } from "./record-values.js";

export function parseAuditEvent(
  row: Record<string, unknown>,
): LifeOpsAuditEvent {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    eventType: toText(row.event_type) as LifeOpsAuditEvent["eventType"],
    ownerType: toText(row.owner_type) as LifeOpsAuditEvent["ownerType"],
    ownerId: toText(row.owner_id),
    reason: toText(row.reason),
    inputs: parseJsonRecord(row.inputs_json),
    decision: parseJsonRecord(row.decision_json),
    actor: toText(row.actor) as LifeOpsAuditEvent["actor"],
    createdAt: toText(row.created_at),
  };
}

export function parseCommitmentLedgerRecord(
  row: Record<string, unknown>,
): LifeOpsCommitmentLedgerRecord {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    source: toText(row.source) as LifeOpsCommitmentSource,
    sourceKey: toText(row.source_key),
    kind: toText(row.kind) as LifeOpsCommitmentKind,
    summary: toText(row.summary),
    counterparty: row.counterparty ? toText(row.counterparty) : null,
    dueAt: row.due_at ? toText(row.due_at) : null,
    confidence: toNumber(row.confidence),
    status: toText(row.status, "open") as LifeOpsCommitmentStatus,
    scheduledTaskId: row.scheduled_task_id
      ? toText(row.scheduled_task_id)
      : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseDelegationContractRecord(
  row: Record<string, unknown>,
): LifeOpsDelegationContractRecord {
  const scope = parseJsonValue<DelegationScope | null>(row.scope_json, null);
  if (!scope) {
    throw new Error("[LifeOpsRepository] delegation contract missing scope.");
  }
  const tripwires = parseJsonValue<readonly DelegationTripwire[]>(
    row.tripwires_json,
    [],
  );
  const sla = parseJsonValue<DelegationSlaPolicy | null>(row.sla_json, null);
  const state = parseJsonRecord(row.state_json);
  return {
    contractId: toText(row.id),
    agentId: toText(row.agent_id),
    status: toText(
      row.status,
      "active",
    ) as LifeOpsDelegationContractRecord["status"],
    objective: toText(row.objective),
    scope,
    autonomyLevel: toText(row.autonomy_level) as DelegationAutonomyLevel,
    tripwires,
    ownerUserId: toText(row.owner_user_id),
    requestedBy: toText(row.requested_by),
    state: state as NonNullable<LifeOpsDelegationContractRecord["state"]>,
    ...(sla ? { sla } : {}),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    expiresAt: toText(row.expires_at),
  };
}

export function createLifeOpsAuditEvent(
  params: Omit<LifeOpsAuditEvent, "id" | "createdAt">,
): LifeOpsAuditEvent {
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: isoNow(),
  };
}

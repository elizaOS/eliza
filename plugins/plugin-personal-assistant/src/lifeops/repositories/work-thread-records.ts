/** Parses durable work-thread state, source references, and transition events. */

import { parseJsonArray, toNumber, toText } from "../sql.js";
import type {
  ThreadSourceRef,
  WorkThread,
  WorkThreadEvent,
  WorkThreadEventType,
  WorkThreadStatus,
} from "../work-threads/types.js";
import { parseOptionalJsonRecord } from "./serialized-records.js";

export function parseThreadSourceRefs(value: unknown): ThreadSourceRef[] {
  return parseJsonArray<ThreadSourceRef>(value).filter(
    (ref) =>
      ref &&
      typeof ref === "object" &&
      typeof ref.connector === "string" &&
      ref.connector.length > 0,
  );
}

export function parseWorkThreadRow(row: Record<string, unknown>): WorkThread {
  const primary = parseOptionalJsonRecord<ThreadSourceRef>(
    row.primary_source_ref_json,
  ) ?? { connector: "unknown" };
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ownerEntityId:
      typeof row.owner_entity_id === "string" && row.owner_entity_id.length > 0
        ? row.owner_entity_id
        : null,
    status: toText(row.status, "active") as WorkThreadStatus,
    title: toText(row.title),
    summary: toText(row.summary),
    currentPlanSummary:
      typeof row.current_plan_summary === "string"
        ? row.current_plan_summary
        : null,
    primarySourceRef: primary,
    sourceRefs: parseThreadSourceRefs(row.source_refs_json),
    participantEntityIds: parseJsonArray<string>(
      row.participant_entity_ids_json,
    ).filter((id) => typeof id === "string" && id.length > 0),
    currentScheduledTaskId:
      typeof row.current_scheduled_task_id === "string" &&
      row.current_scheduled_task_id.length > 0
        ? row.current_scheduled_task_id
        : null,
    workflowRunId:
      typeof row.workflow_run_id === "string" && row.workflow_run_id.length > 0
        ? row.workflow_run_id
        : null,
    approvalId:
      typeof row.approval_id === "string" && row.approval_id.length > 0
        ? row.approval_id
        : null,
    lastMessageMemoryId:
      typeof row.last_message_memory_id === "string" &&
      row.last_message_memory_id.length > 0
        ? row.last_message_memory_id
        : null,
    version: toNumber(row.version, 1),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    lastActivityAt: toText(row.last_activity_at),
    metadata: parseOptionalJsonRecord<Record<string, unknown>>(
      row.metadata_json,
    ),
  };
}

export function parseWorkThreadEventRow(
  row: Record<string, unknown>,
): WorkThreadEvent {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    workThreadId: toText(row.work_thread_id),
    occurredAt: toText(row.occurred_at),
    type: toText(row.type, "updated") as WorkThreadEventType,
    reason:
      typeof row.reason === "string" && row.reason.length > 0
        ? row.reason
        : null,
    detail: parseOptionalJsonRecord<Record<string, unknown>>(row.detail_json),
  };
}

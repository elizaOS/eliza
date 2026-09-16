/** Defines and parses scheduled task records for the host persistence adapter, preserving canonical domain contracts. */
import { parseJsonRecord, toBoolean, toText } from "../sql.js";
import { parseOptionalJsonRecord } from "./serialized-records.js";

export function parseScheduledTaskRow(
  row: Record<string, unknown>,
): import("@elizaos/plugin-scheduling").ScheduledTask {
  type StateShape = import("@elizaos/plugin-scheduling").ScheduledTaskState;
  type TaskShape = import("@elizaos/plugin-scheduling").ScheduledTask;
  const stateRaw = parseJsonRecord(row.state_json);
  const state: StateShape = {
    status: ((stateRaw.status as string) ??
      "scheduled") as StateShape["status"],
    firedAt:
      typeof stateRaw.firedAt === "string" ? stateRaw.firedAt : undefined,
    acknowledgedAt:
      typeof stateRaw.acknowledgedAt === "string"
        ? stateRaw.acknowledgedAt
        : undefined,
    completedAt:
      typeof stateRaw.completedAt === "string"
        ? stateRaw.completedAt
        : undefined,
    followupCount:
      typeof stateRaw.followupCount === "number" ? stateRaw.followupCount : 0,
    lastFollowupAt:
      typeof stateRaw.lastFollowupAt === "string"
        ? stateRaw.lastFollowupAt
        : undefined,
    pipelineParentId:
      typeof stateRaw.pipelineParentId === "string"
        ? stateRaw.pipelineParentId
        : undefined,
    lastDecisionLog:
      typeof stateRaw.lastDecisionLog === "string"
        ? stateRaw.lastDecisionLog
        : undefined,
  };
  const subjectKind = toText(row.subject_kind, "");
  const subjectId = toText(row.subject_id, "");
  const parsedMetadata =
    parseOptionalJsonRecord<Record<string, unknown>>(row.metadata_json) ?? {};
  if (
    typeof row.created_at === "string" &&
    typeof parsedMetadata.createdAtIso !== "string"
  ) {
    parsedMetadata.createdAtIso = row.created_at;
  }
  return {
    taskId: toText(row.id),
    kind: toText(row.kind) as TaskShape["kind"],
    promptInstructions: toText(row.prompt_instructions),
    contextRequest: parseOptionalJsonRecord<TaskShape["contextRequest"]>(
      row.context_request_json,
    ),
    trigger: parseJsonRecord(row.trigger_json) as TaskShape["trigger"],
    priority: toText(row.priority, "medium") as TaskShape["priority"],
    shouldFire: parseOptionalJsonRecord<TaskShape["shouldFire"]>(
      row.should_fire_json,
    ),
    completionCheck: parseOptionalJsonRecord<TaskShape["completionCheck"]>(
      row.completion_check_json,
    ),
    escalation: parseOptionalJsonRecord<TaskShape["escalation"]>(
      row.escalation_json,
    ),
    output: parseOptionalJsonRecord<TaskShape["output"]>(row.output_json),
    pipeline: parseOptionalJsonRecord<TaskShape["pipeline"]>(row.pipeline_json),
    subject:
      subjectKind && subjectId
        ? ({
            kind: subjectKind,
            id: subjectId,
          } as TaskShape["subject"])
        : undefined,
    idempotencyKey:
      typeof row.idempotency_key === "string" && row.idempotency_key.length > 0
        ? row.idempotency_key
        : undefined,
    respectsGlobalPause: toBoolean(row.respects_global_pause, true),
    state,
    source: toText(row.source, "user_chat") as TaskShape["source"],
    createdBy: toText(row.created_by, ""),
    ownerVisible: toBoolean(row.owner_visible, true),
    metadata: parsedMetadata,
    executionProfile:
      typeof row.execution_profile === "string"
        ? (row.execution_profile as TaskShape["executionProfile"])
        : undefined,
  };
}

export function parseScheduledTaskLogRow(
  row: Record<string, unknown>,
): import("@elizaos/plugin-scheduling").ScheduledTaskLogEntry {
  type LogShape = import("@elizaos/plugin-scheduling").ScheduledTaskLogEntry;
  return {
    logId: toText(row.id),
    taskId: toText(row.task_id),
    agentId: toText(row.agent_id),
    occurredAtIso: toText(row.occurred_at),
    transition: toText(row.transition) as LogShape["transition"],
    reason: typeof row.reason === "string" ? row.reason : undefined,
    rolledUp: toBoolean(row.rolled_up, false),
    detail: parseOptionalJsonRecord<Record<string, unknown>>(row.detail_json),
  };
}

/** Constructs and parses workflow definitions and runs with validated idempotency keys. */

import crypto from "node:crypto";
import { ElizaError } from "@elizaos/core";
import type {
  LifeOpsWorkflowDefinition,
  LifeOpsWorkflowRun,
} from "../../contracts/index.js";
import { DEFAULT_WORKFLOW_PERMISSION_POLICY } from "../service-constants.js";
import { parseJsonRecord, parseJsonValue, toText } from "../sql.js";
import { isoNow, parseOwnershipFields } from "./record-values.js";

export function parseWorkflowDefinition(
  row: Record<string, unknown>,
): LifeOpsWorkflowDefinition {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ...parseOwnershipFields(row),
    title: toText(row.title),
    triggerType: toText(
      row.trigger_type,
    ) as LifeOpsWorkflowDefinition["triggerType"],
    schedule: parseJsonValue<LifeOpsWorkflowDefinition["schedule"]>(
      row.schedule_json,
      { kind: "manual" },
    ),
    actionPlan: parseJsonValue<LifeOpsWorkflowDefinition["actionPlan"]>(
      row.action_plan_json,
      { steps: [] },
    ),
    permissionPolicy: parseJsonValue<
      LifeOpsWorkflowDefinition["permissionPolicy"]
    >(row.permission_policy_json, DEFAULT_WORKFLOW_PERMISSION_POLICY),
    status: toText(row.status) as LifeOpsWorkflowDefinition["status"],
    createdBy: toText(row.created_by) as LifeOpsWorkflowDefinition["createdBy"],
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseWorkflowRun(
  row: Record<string, unknown>,
): LifeOpsWorkflowRun {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    workflowId: toText(row.workflow_id),
    idempotencyKey:
      typeof row.idempotency_key === "string" ? row.idempotency_key : null,
    startedAt: toText(row.started_at),
    finishedAt: row.finished_at ? toText(row.finished_at) : null,
    status: toText(row.status) as LifeOpsWorkflowRun["status"],
    result: parseJsonRecord(row.result_json),
    auditRef: row.audit_ref ? toText(row.audit_ref) : null,
  };
}

export const TERMINAL_WORKFLOW_RUN_STATUSES = new Set<
  LifeOpsWorkflowRun["status"]
>(["success", "failed", "failed_uncompensated", "cancelled"]);

export function assertValidWorkflowRunIdempotencyKey(
  idempotencyKey: string | null | undefined,
): void {
  if (idempotencyKey === null || idempotencyKey === undefined) return;
  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > 256 ||
    idempotencyKey.includes("\0")
  ) {
    throw new ElizaError(
      "[LifeOpsRepository] Workflow run idempotency key must contain 1 to 256 non-NUL characters",
      {
        code: "LIFEOPS_WORKFLOW_RUN_IDEMPOTENCY_KEY_INVALID",
        context: {
          length: idempotencyKey.length,
          containsNul: idempotencyKey.includes("\0"),
        },
      },
    );
  }
}

export function createLifeOpsWorkflowDefinition(
  params: Omit<LifeOpsWorkflowDefinition, "id" | "createdAt" | "updatedAt">,
): LifeOpsWorkflowDefinition {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsWorkflowRun(
  params: Omit<LifeOpsWorkflowRun, "id">,
): LifeOpsWorkflowRun {
  return {
    ...params,
    id: crypto.randomUUID(),
  };
}

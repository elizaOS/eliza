/**
 * Bridges a chat action result that produced a workflow into the workflow graph
 * viewer: scans action results (most-recent-successful first) for a `workflowId`
 * value and dispatches the visualize-workflow event so the graph opens on it.
 */

import type { ChatActionResultSummary } from "../../api/client-types-chat";
import { dispatchVisualizeWorkflow } from "./workflow-graph-events";

function readWorkflowId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function findWorkflowIdForActionHandoff(
  actionResults: readonly ChatActionResultSummary[] | undefined,
): string | null {
  if (!Array.isArray(actionResults)) return null;
  for (let index = actionResults.length - 1; index >= 0; index--) {
    const result = actionResults[index];
    if (!result || result.success === false) continue;
    const workflowId = readWorkflowId(result.values?.workflowId);
    if (workflowId) return workflowId;
  }
  return null;
}

export function dispatchWorkflowActionHandoff(
  actionResults: readonly ChatActionResultSummary[] | undefined,
): boolean {
  const workflowId = findWorkflowIdForActionHandoff(actionResults);
  if (!workflowId) return false;
  dispatchVisualizeWorkflow(workflowId);
  return true;
}

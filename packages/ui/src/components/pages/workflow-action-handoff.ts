/**
 * Bridges successful WORKFLOW chat actions into the Automations workflow
 * editor. The URL deep-link survives a view remount while the visualization
 * event updates an Automations feed that is already mounted.
 */

import type { ChatActionResultSummary } from "../../api/client-types-chat";
import { dispatchNavigateViewEvent } from "../../events";
import { formatAutomationHash } from "../../hooks/useAutomationDeepLink";
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
    if (
      result?.success !== true ||
      result.actionName?.toUpperCase() !== "WORKFLOW"
    ) {
      continue;
    }
    const workflowId = readWorkflowId(result.values?.workflowId);
    if (workflowId) return workflowId;
  }
  return null;
}

export function dispatchWorkflowActionHandoff(
  actionResults: readonly ChatActionResultSummary[] | undefined,
  dependencies: {
    dispatchNavigate?: typeof dispatchNavigateViewEvent;
    dispatchVisualize?: typeof dispatchVisualizeWorkflow;
  } = {},
): boolean {
  const workflowId = findWorkflowIdForActionHandoff(actionResults);
  if (!workflowId) return false;
  const workflowHash = formatAutomationHash({
    kind: "workflow",
    id: workflowId,
  });
  const dispatchNavigate =
    dependencies.dispatchNavigate ?? dispatchNavigateViewEvent;
  dispatchNavigate({
    viewId: "automations",
    viewPath: `/automations${workflowHash}`,
  });
  // The URL deep-link opens the editor when AutomationsFeed mounts. The event
  // covers the already-mounted case because pushState emits popstate rather
  // than hashchange, so the existing feed can update without a remount.
  const dispatchVisualize =
    dependencies.dispatchVisualize ?? dispatchVisualizeWorkflow;
  dispatchVisualize(workflowId);
  return true;
}

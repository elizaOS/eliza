/**
 * Cross-component event bus for "show me this workflow" deep-links.
 *
 * Dispatched from chat surfaces (e.g. when the agent replies about a
 * workflow it just created or modified) and consumed by AutomationsFeed,
 * which scrolls the matching row into view and opens its editor.
 *
 * Restored from the deleted AutomationsView.tsx — keep this file thin.
 */

export const VISUALIZE_WORKFLOW_EVENT = "eliza:automations:visualize-workflow";

export interface VisualizeWorkflowEventDetail {
  workflowId: string;
}

export function dispatchVisualizeWorkflow(workflowId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<VisualizeWorkflowEventDetail>(VISUALIZE_WORKFLOW_EVENT, {
      detail: { workflowId },
    }),
  );
}

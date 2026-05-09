// Event consumer for agent-driven graph focus
export const VISUALIZE_WORKFLOW_EVENT = "eliza:automations:visualize-workflow";

export interface VisualizeWorkflowEventDetail {
  workflowId: string;
}

export function dispatchVisualizeWorkflow(workflowId: string): void {
  window.dispatchEvent(
    new CustomEvent<VisualizeWorkflowEventDetail>(VISUALIZE_WORKFLOW_EVENT, {
      detail: { workflowId },
    }),
  );
}

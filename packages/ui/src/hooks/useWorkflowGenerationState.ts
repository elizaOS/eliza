/**
 * useWorkflowGenerationState — listens for workflow-generation lifecycle
 * events emitted by chat panes / generators and reports whether a given
 * workflow is currently being generated.
 *
 * Event protocol: CustomEvent on `window` with type
 * `eliza:automations:workflow-generating` and detail
 * `{ workflowId: string; inProgress: boolean }`.
 *
 * Pass `null`/`undefined` to disable. Event with no `workflowId` matches
 * any current selection (used by the toolbar "generating…" indicator).
 */

import { useEffect, useState } from "react";

export const WORKFLOW_GENERATING_EVENT =
  "eliza:automations:workflow-generating";

export interface WorkflowGeneratingEventDetail {
  workflowId?: string;
  inProgress: boolean;
}

export function emitWorkflowGenerating(
  workflowId: string | null,
  inProgress: boolean,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorkflowGeneratingEventDetail>(WORKFLOW_GENERATING_EVENT, {
      detail: { workflowId: workflowId ?? undefined, inProgress },
    }),
  );
}

export function useWorkflowGenerationState(
  workflowId: string | null | undefined,
): boolean {
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    setGenerating(false);
    if (!workflowId) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowGeneratingEventDetail>)
        .detail;
      if (!detail) return;
      if (!detail.workflowId || detail.workflowId === workflowId) {
        setGenerating(detail.inProgress);
      }
    };
    window.addEventListener(WORKFLOW_GENERATING_EVENT, handler);
    return () => {
      window.removeEventListener(WORKFLOW_GENERATING_EVENT, handler);
    };
  }, [workflowId]);

  return generating;
}

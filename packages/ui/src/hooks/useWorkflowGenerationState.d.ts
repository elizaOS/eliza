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
export declare const WORKFLOW_GENERATING_EVENT = "eliza:automations:workflow-generating";
export interface WorkflowGeneratingEventDetail {
    workflowId?: string;
    inProgress: boolean;
}
export declare function emitWorkflowGenerating(workflowId: string | null, inProgress: boolean): void;
export declare function useWorkflowGenerationState(workflowId: string | null | undefined): boolean;
//# sourceMappingURL=useWorkflowGenerationState.d.ts.map
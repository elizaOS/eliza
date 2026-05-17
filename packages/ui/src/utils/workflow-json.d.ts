/**
 * workflow-json — parse and round-trip a workflow JSON string into the
 * shape expected by `WorkflowGraphViewer`. Used by the text-first
 * `WorkflowEditor` to re-render the graph as the user edits the JSON.
 *
 * The JSON contract intentionally mirrors `WorkflowDefinitionWriteRequest`
 * with a couple of additions (`id`, `description`, `active`) so we can
 * round-trip a `WorkflowDefinition` losslessly.
 */
import type {
  WorkflowConnectionMap,
  WorkflowDefinition,
  WorkflowDefinitionNode,
  WorkflowDefinitionWriteRequest,
} from "../api/client-types-chat";
export interface WorkflowJsonShape {
  id?: string;
  name: string;
  description?: string;
  active?: boolean;
  nodes: WorkflowDefinitionNode[];
  connections?: WorkflowConnectionMap;
  settings?: Record<string, unknown>;
}
export interface ParsedWorkflowJson {
  ok: true;
  workflow: WorkflowDefinition;
  /** The validated `settings` block, ready to send to the write endpoint. */
  settings: Record<string, unknown>;
}
export interface InvalidWorkflowJson {
  ok: false;
  /** Human-readable error message — safe to render directly. */
  message: string;
  /** Optional 1-based line number when JSON parse failed. */
  line?: number;
}
export type WorkflowJsonResult = ParsedWorkflowJson | InvalidWorkflowJson;
/**
 * Parse the JSON-text input from the WorkflowEditor. On success returns a
 * `WorkflowDefinition` ready to feed into `WorkflowGraphViewer`. On
 * failure returns a structured error the caller can render inline.
 */
export declare function parseWorkflowJson(text: string): WorkflowJsonResult;
/** Pretty-print a workflow definition for the editor. */
export declare function workflowToJsonText(
  workflow: WorkflowDefinition | null,
): string;
/** Build the request payload for create / update endpoints. */
export declare function toWriteRequest(
  parsed: ParsedWorkflowJson,
): WorkflowDefinitionWriteRequest;
//# sourceMappingURL=workflow-json.d.ts.map

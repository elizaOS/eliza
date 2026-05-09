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
  WorkflowDefinitionWriteNode,
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lineFromOffset(source: string, offset: number): number {
  if (offset <= 0) return 1;
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Parse the JSON-text input from the WorkflowEditor. On success returns a
 * `WorkflowDefinition` ready to feed into `WorkflowGraphViewer`. On
 * failure returns a structured error the caller can render inline.
 */
export function parseWorkflowJson(text: string): WorkflowJsonResult {
  if (!text.trim()) {
    return { ok: false, message: "Workflow JSON is empty." };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON.";
    const offsetMatch = message.match(/position (\d+)/i);
    const offset = offsetMatch ? Number.parseInt(offsetMatch[1], 10) : -1;
    const line = offset >= 0 ? lineFromOffset(text, offset) : undefined;
    return { ok: false, message, line };
  }

  if (!isObject(raw)) {
    return { ok: false, message: "Workflow JSON must be an object." };
  }
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    return { ok: false, message: "Workflow `name` is required." };
  }
  if (!Array.isArray(raw.nodes)) {
    return { ok: false, message: "Workflow `nodes` must be an array." };
  }
  for (let i = 0; i < raw.nodes.length; i++) {
    const node = raw.nodes[i];
    if (!isObject(node)) {
      return { ok: false, message: `Node ${i} must be an object.` };
    }
    if (typeof node.name !== "string" || !node.name) {
      return { ok: false, message: `Node ${i} is missing a \`name\`.` };
    }
    if (typeof node.type !== "string" || !node.type) {
      return { ok: false, message: `Node ${i} is missing a \`type\`.` };
    }
  }
  const connections =
    raw.connections === undefined
      ? {}
      : isObject(raw.connections)
        ? (raw.connections as WorkflowConnectionMap)
        : null;
  if (connections === null) {
    return { ok: false, message: "Workflow `connections` must be an object." };
  }
  const settings = isObject(raw.settings) ? raw.settings : {};

  const workflow: WorkflowDefinition = {
    id: typeof raw.id === "string" ? raw.id : "draft",
    name: raw.name,
    active: raw.active === true,
    description:
      typeof raw.description === "string" ? raw.description : undefined,
    nodes: raw.nodes as WorkflowDefinitionNode[],
    connections,
    nodeCount: (raw.nodes as unknown[]).length,
  };

  return { ok: true, workflow, settings };
}

/** Pretty-print a workflow definition for the editor. */
export function workflowToJsonText(
  workflow: WorkflowDefinition | null,
): string {
  if (!workflow) {
    return JSON.stringify(
      { name: "New workflow", nodes: [], connections: {} },
      null,
      2,
    );
  }
  const shape: WorkflowJsonShape = {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    active: workflow.active,
    nodes: workflow.nodes ?? [],
    connections: workflow.connections ?? {},
  };
  return JSON.stringify(shape, null, 2);
}

/**
 * Coerce a viewer node into the stricter write-node shape — fills in
 * sensible defaults for `typeVersion`, `position`, and `parameters` when
 * the editor JSON omits them. The workflow plugin's write endpoint
 * normalises these on its end too, but enforcing them here keeps the
 * types honest and surfaces missing fields as soon as the user clicks
 * Save rather than after a round-trip.
 */
function toWriteNode(node: WorkflowDefinitionNode): WorkflowDefinitionWriteNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    typeVersion: node.typeVersion ?? 1,
    position: node.position ?? [0, 0],
    parameters: node.parameters ?? {},
    notes: node.notes,
    notesInFlow: node.notesInFlow,
  };
}

/** Build the request payload for create / update endpoints. */
export function toWriteRequest(
  parsed: ParsedWorkflowJson,
): WorkflowDefinitionWriteRequest {
  return {
    name: parsed.workflow.name,
    nodes: (parsed.workflow.nodes ?? []).map(toWriteNode),
    connections: parsed.workflow.connections ?? {},
    settings: parsed.settings,
  };
}

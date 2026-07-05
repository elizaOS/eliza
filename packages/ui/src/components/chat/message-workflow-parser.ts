/**
 * Parser for `[WORKFLOW]\n{...json...}\n[/WORKFLOW]` blocks an agent emits to
 * render a multi-step progress list inline (issue #13536 §(d)). Mirrors
 * `message-form-parser.ts` so unit tests exercise the schema parsing without the
 * `MessageContent` React graph. The block re-parses whenever the assistant
 * message updates, so re-emitting it with advanced step statuses mutates the
 * rendered list in place.
 *
 * Body shape:
 *   {
 *     "id"?: string,                 // stable id; generated if omitted
 *     "title"?: string,
 *     "steps": [
 *       { "label": string, "status"?: "pending"|"running"|"done"|"failed" }
 *     ]
 *   }
 */

export type WorkflowStepStatus = "pending" | "running" | "done" | "failed";

export interface WorkflowStepSpec {
  label: string;
  status: WorkflowStepStatus;
}

export interface WorkflowSpec {
  id: string;
  title?: string;
  steps: WorkflowStepSpec[];
}

/** Hard cap so a runaway agent can't render an unbounded step list. */
export const MAX_WORKFLOW_STEPS = 40;

const STEP_STATUSES = new Set<WorkflowStepStatus>([
  "pending",
  "running",
  "done",
  "failed",
]);

export const WORKFLOW_RE = /\[WORKFLOW\]\n([\s\S]*?)\n\[\/WORKFLOW\]/g;

function generateId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `wf-${Math.random().toString(36).slice(2, 10)}`;
}

function parseStep(raw: unknown): WorkflowStepSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const label = record.label;
  if (typeof label !== "string" || label.trim().length === 0) return null;
  const status =
    typeof record.status === "string" &&
    STEP_STATUSES.has(record.status as WorkflowStepStatus)
      ? (record.status as WorkflowStepStatus)
      : "pending";
  return { label: label.trim(), status };
}

/** Parse a `[WORKFLOW]` body into a normalized spec, or `null` if malformed. */
export function parseWorkflowBody(body: string): WorkflowSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // error-policy:J3 untrusted model output — null is the explicit "malformed"
    // signal so the block falls back to rendering as plain text.
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.steps)) return null;

  const steps: WorkflowStepSpec[] = [];
  for (const rawStep of record.steps) {
    if (steps.length >= MAX_WORKFLOW_STEPS) break;
    const step = parseStep(rawStep);
    if (step) steps.push(step);
  }
  if (steps.length === 0) return null;

  return {
    id:
      typeof record.id === "string" && record.id.length > 0
        ? record.id
        : generateId(),
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    steps,
  };
}

export interface WorkflowMatch {
  start: number;
  end: number;
  workflow: WorkflowSpec;
}

/** Find every WORKFLOW block in `text` and return their character regions. */
export function findWorkflowRegions(text: string): WorkflowMatch[] {
  const results: WorkflowMatch[] = [];
  WORKFLOW_RE.lastIndex = 0;
  let m: RegExpExecArray | null = WORKFLOW_RE.exec(text);
  while (m !== null) {
    const workflow = parseWorkflowBody(m[1]);
    if (workflow) {
      results.push({ start: m.index, end: m.index + m[0].length, workflow });
    }
    m = WORKFLOW_RE.exec(text);
  }
  return results;
}

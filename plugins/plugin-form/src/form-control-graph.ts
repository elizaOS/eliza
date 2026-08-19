/**
 * Bounds the nested FormControl.fields graph before template resolution
 * walks it. Persisted sessions and LLM-authored forms can carry a hostile
 * nest or a cycle; an unbounded recursive walk stack-overflows the agent
 * event loop. Depth, node, and cycle limits are all load-bearing — one
 * axis alone still overflows the others.
 */

export const MAX_FORM_CONTROL_DEPTH = 32;
export const MAX_FORM_CONTROL_NODES = 2_048;

export class FormControlGraphError extends Error {
  readonly name = "FormControlGraphError";

  constructor(
    message: string,
    readonly code: "FORM_CONTROL_UNBOUNDED",
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type NestedControl = {
  fields?: readonly NestedControl[];
};

/**
 * Fail closed on a FormControl graph that would recurse without bound.
 * Call before walking `fields` for template resolution or extraction.
 */
export function assertFormControlGraph(control: NestedControl): void {
  walk(control, 0, 0, new WeakSet<object>());
}

function walk(
  control: NestedControl,
  depth: number,
  visits: number,
  visiting: WeakSet<object>,
): number {
  if (depth > MAX_FORM_CONTROL_DEPTH) {
    throw new FormControlGraphError(
      `form control nesting exceeds ${MAX_FORM_CONTROL_DEPTH}`,
      "FORM_CONTROL_UNBOUNDED",
      { depth, maxDepth: MAX_FORM_CONTROL_DEPTH },
    );
  }
  const nextVisits = visits + 1;
  if (nextVisits > MAX_FORM_CONTROL_NODES) {
    throw new FormControlGraphError(
      `form control graph exceeds ${MAX_FORM_CONTROL_NODES} nodes`,
      "FORM_CONTROL_UNBOUNDED",
      { visits: nextVisits, maxNodes: MAX_FORM_CONTROL_NODES },
    );
  }
  if (typeof control === "object" && control !== null) {
    if (visiting.has(control)) {
      throw new FormControlGraphError(
        "form control graph contains a cycle",
        "FORM_CONTROL_UNBOUNDED",
        { depth },
      );
    }
    visiting.add(control);
  }
  let seen = nextVisits;
  try {
    const fields = control.fields;
    if (!fields) return seen;
    for (const field of fields) {
      seen = walk(field, depth + 1, seen, visiting);
    }
    return seen;
  } finally {
    if (typeof control === "object" && control !== null) {
      visiting.delete(control);
    }
  }
}

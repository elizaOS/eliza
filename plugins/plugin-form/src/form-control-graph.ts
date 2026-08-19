/**
 * Bounds the nested FormControl.fields graph before template resolution
 * walks it. Persisted sessions and LLM-authored forms can carry a hostile
 * nest or a cycle; an unbounded recursive walk stack-overflows the agent
 * event loop. Depth, node, and cycle limits are all load-bearing — one
 * axis alone still overflows the others.
 */

import { ElizaError } from "@elizaos/core";

export const MAX_FORM_CONTROL_DEPTH = 32;
export const MAX_FORM_CONTROL_NODES = 2_048;

export class FormControlGraphError extends ElizaError {
  override readonly name = "FormControlGraphError";

  constructor(
    message: string,
    code: "FORM_CONTROL_UNBOUNDED",
    context?: Record<string, unknown>,
  ) {
    super(message, { code, context, severity: "fatal" });
  }
}

type NestedControl = {
  fields?: readonly NestedControl[];
  options?: readonly unknown[];
  extractHints?: readonly unknown[];
};

/**
 * Fail closed on a FormControl graph that would recurse without bound.
 * Call before walking `fields` for template resolution or extraction.
 */
export function assertFormControlGraph(control: NestedControl): void {
  walk(control, 0, { visits: 0, visiting: new WeakSet<object>() });
}

/** Bound a complete form's top-level controls with one shared work budget. */
export function assertFormControlGraphs(
  controls: readonly NestedControl[],
): void {
  const context: WalkContext = { visits: 0, visiting: new WeakSet<object>() };
  reserveVisits(context, controls.length);
  for (let index = 0; index < controls.length; index++) {
    if (!(index in controls)) continue;
    walk(controls[index], 0, context, true);
  }
}

type WalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

function reserveVisits(context: WalkContext, count: number): void {
  if (count > MAX_FORM_CONTROL_NODES - context.visits) {
    throw new FormControlGraphError(
      `form control graph exceeds ${MAX_FORM_CONTROL_NODES} nodes`,
      "FORM_CONTROL_UNBOUNDED",
      {
        visits: context.visits + count,
        maxNodes: MAX_FORM_CONTROL_NODES,
      },
    );
  }
  context.visits += count;
}

function walk(
  control: NestedControl,
  depth: number,
  context: WalkContext,
  visitAlreadyReserved = false,
): void {
  if (!visitAlreadyReserved) reserveVisits(context, 1);
  if (depth > MAX_FORM_CONTROL_DEPTH) {
    throw new FormControlGraphError(
      `form control nesting exceeds ${MAX_FORM_CONTROL_DEPTH}`,
      "FORM_CONTROL_UNBOUNDED",
      { depth, maxDepth: MAX_FORM_CONTROL_DEPTH },
    );
  }
  if (typeof control === "object" && control !== null) {
    if (context.visiting.has(control)) {
      throw new FormControlGraphError(
        "form control graph contains a cycle",
        "FORM_CONTROL_UNBOUNDED",
        { depth },
      );
    }
    context.visiting.add(control);
  }
  try {
    // These arrays are mapped by template resolution too. Count their logical
    // slots so a cheaply allocated sparse array cannot force an unbounded scan.
    reserveVisits(context, control.options?.length ?? 0);
    reserveVisits(context, control.extractHints?.length ?? 0);
    const fields = control.fields;
    if (!fields) return;
    // Array transforms still inspect every logical index. Charge the complete
    // length before iteration so sparse arrays cannot bypass the graph budget.
    reserveVisits(context, fields.length);
    for (let index = 0; index < fields.length; index++) {
      if (!(index in fields)) continue;
      walk(fields[index], depth + 1, context, true);
    }
  } finally {
    if (typeof control === "object" && control !== null) {
      context.visiting.delete(control);
    }
  }
}

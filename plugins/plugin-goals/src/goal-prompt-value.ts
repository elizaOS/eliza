/**
 * Bounded rendering of mixed goal/evidence values into the semantic-evaluator
 * prompt. Hostile depth, fan-out, or cycles fail closed so a review job cannot
 * RangeError the event loop. Callers interpolate the returned string; they do
 * not walk the graph themselves.
 */
import { fail } from "./goal-normalize.ts";

/** Nesting ceiling. Honest goal/evidence records are a handful of objects deep. */
export const MAX_GOAL_PROMPT_VALUE_DEPTH = 32;
/** Node ceiling across the whole prompt walk, including leaves. */
export const MAX_GOAL_PROMPT_VALUE_NODES = 2048;
export const GOAL_PROMPT_VALUE_UNBOUNDED = "GOAL_PROMPT_VALUE_UNBOUNDED";

type PromptWalkContext = {
  visits: number;
  ancestors: WeakSet<object>;
};

function failUnbounded(
  axis: "depth" | "visits" | "cycle",
  context: Record<string, unknown>,
): never {
  const message =
    axis === "depth"
      ? `goal prompt value exceeds ${MAX_GOAL_PROMPT_VALUE_DEPTH} nesting depth`
      : axis === "visits"
        ? `goal prompt value exceeds ${MAX_GOAL_PROMPT_VALUE_NODES} nodes`
        : "goal prompt value contains a cyclic object";
  fail(
    400,
    `${message} (${JSON.stringify(context)})`,
    GOAL_PROMPT_VALUE_UNBOUNDED,
  );
}

/**
 * Render a mixed nested value into the evaluator prompt. Hostile depth,
 * fan-out, or cycles fail closed with {@link GOAL_PROMPT_VALUE_UNBOUNDED}
 * instead of RangeError-ing the review job.
 */
export function formatPromptValue(value: unknown): string {
  return formatPromptValueAt(value, 0, {
    visits: 0,
    ancestors: new WeakSet<object>(),
  });
}

function formatPromptValueAt(
  value: unknown,
  depth: number,
  ctx: PromptWalkContext,
): string {
  if (depth > MAX_GOAL_PROMPT_VALUE_DEPTH) {
    failUnbounded("depth", { depth, max: MAX_GOAL_PROMPT_VALUE_DEPTH });
  }
  ctx.visits += 1;
  if (ctx.visits > MAX_GOAL_PROMPT_VALUE_NODES) {
    failUnbounded("visits", {
      visits: ctx.visits,
      max: MAX_GOAL_PROMPT_VALUE_NODES,
    });
  }

  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (value === null) return "null";
  if (value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (ctx.ancestors.has(value)) {
      failUnbounded("cycle", { depth });
    }
    if (value.length === 0) return "(none)";
    ctx.ancestors.add(value);
    try {
      return value
        .map(
          (entry) =>
            `${childIndent}- ${formatPromptValueAt(entry, depth + 1, ctx)}`,
        )
        .join("\n");
    } finally {
      ctx.ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    if (ctx.ancestors.has(value)) {
      failUnbounded("cycle", { depth });
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "(empty)";
    ctx.ancestors.add(value);
    try {
      return entries
        .map(([key, entry]) => {
          const formatted = formatPromptValueAt(entry, depth + 1, ctx);
          return formatted.includes("\n")
            ? `${indent}${key}:\n${formatted}`
            : `${indent}${key}: ${formatted}`;
        })
        .join("\n");
    } finally {
      ctx.ancestors.delete(value);
    }
  }
  return String(value);
}

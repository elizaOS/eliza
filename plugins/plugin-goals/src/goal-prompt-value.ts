/**
 * Complete rendering of mixed goal/evidence values into the semantic-evaluator
 * prompt. Hostile depth, cycles, sparse slots, and accessors fail closed so a
 * review job cannot RangeError or invoke untrusted reflection hooks.
 */
import { fail, GoalsServiceError } from "./goal-normalize.ts";

/** Nesting ceiling. Honest goal/evidence records are a handful of objects deep. */
export const MAX_GOAL_PROMPT_VALUE_DEPTH = 32;
export const GOAL_PROMPT_VALUE_UNBOUNDED = "GOAL_PROMPT_VALUE_UNBOUNDED";

type PromptWalkContext = {
  ancestors: WeakSet<object>;
};

function failUnbounded(
  axis: "depth" | "cycle" | "reflection",
  context: Record<string, unknown>,
): never {
  const message =
    axis === "depth"
      ? `goal prompt value exceeds ${MAX_GOAL_PROMPT_VALUE_DEPTH} nesting depth`
      : axis === "cycle"
        ? "goal prompt value contains a cyclic object"
        : "goal prompt value could not be inspected safely";
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
  if (typeof value === "object") {
    if (ctx.ancestors.has(value)) {
      failUnbounded("cycle", { depth });
    }
    ctx.ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(
          value,
          "length",
        );
        const length = lengthDescriptor?.value;
        if (!Number.isSafeInteger(length) || length < 0) {
          failUnbounded("reflection", {
            kind: "array-length",
            length: typeof length === "number" ? length : "invalid",
          });
        }
        if (length === 0) return "(none)";
        const parts: string[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (!descriptor || "get" in descriptor || "set" in descriptor) {
            failUnbounded("reflection", { kind: "array-slot", index });
          }
          const part = `${childIndent}- ${formatPromptValueAt(descriptor.value, depth + 1, ctx)}`;
          parts.push(part);
        }
        return parts.join("\n");
      }

      const parts: string[] = [];
      for (const key in value) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable) continue;
        if ("get" in descriptor || "set" in descriptor) {
          failUnbounded("reflection", { kind: "object-accessor" });
        }
        const formatted = formatPromptValueAt(descriptor.value, depth + 1, ctx);
        const part = formatted.includes("\n")
          ? `${indent}${key}:\n${formatted}`
          : `${indent}${key}: ${formatted}`;
        parts.push(part);
      }
      return parts.length === 0 ? "(empty)" : parts.join("\n");
    } catch (error) {
      if (
        error instanceof GoalsServiceError &&
        error.code === GOAL_PROMPT_VALUE_UNBOUNDED
      ) {
        throw error;
      }
      failUnbounded("reflection", {
        kind: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      ctx.ancestors.delete(value);
    }
  }
  failUnbounded("reflection", { kind: typeof value });
}

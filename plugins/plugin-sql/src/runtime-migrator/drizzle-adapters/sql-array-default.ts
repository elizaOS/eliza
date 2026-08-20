/**
 * SQL array-literal rendering for Drizzle column defaults. Nested array
 * defaults recurse without a budget in Drizzle's own serializer; depth, wide
 * sparse arrays, and oversized literals must fail before migration work grows
 * without bound.
 */
import { ElizaError } from "@elizaos/core";

/** Nesting ceiling. Honest pg array defaults are one or two levels. */
export const MAX_SQL_ARRAY_DEFAULT_DEPTH = 32;
/** Total array slots allowed across the rendered default, including sparse holes. */
export const MAX_SQL_ARRAY_DEFAULT_ELEMENTS = 4096;
/** Maximum serialized SQL array-literal size. */
export const MAX_SQL_ARRAY_DEFAULT_CHARS = 1024 * 1024;
export const SQL_ARRAY_DEFAULT_UNBOUNDED = "SQL_ARRAY_DEFAULT_UNBOUNDED";

export type SqlArrayDefaultElement =
  | number
  | bigint
  | boolean
  | string
  | Date
  | object
  | SqlArrayDefaultElement[];

type RenderBudget = {
  elements: number;
  chars: number;
  ancestors: WeakSet<object>;
};

function failUnbounded(
  axis: "depth" | "elements" | "chars" | "cycle",
  context: Record<string, unknown>
): never {
  throw new ElizaError(`sql array default exceeds its ${axis} budget`, {
    code: SQL_ARRAY_DEFAULT_UNBOUNDED,
    context,
    severity: "fatal",
  });
}

function reserveChars(budget: RenderBudget, chars: number): void {
  budget.chars += chars;
  if (budget.chars > MAX_SQL_ARRAY_DEFAULT_CHARS) {
    failUnbounded("chars", { chars: budget.chars, max: MAX_SQL_ARRAY_DEFAULT_CHARS });
  }
}

/**
 * Render a JS array as a Postgres array literal under shared depth, element,
 * cycle, and output budgets.
 */
export function buildArrayString(array: SqlArrayDefaultElement[], sqlType: string): string {
  return renderArray(array, sqlType.split("[")[0], 0, {
    elements: 0,
    chars: 0,
    ancestors: new WeakSet(),
  });
}

function renderArray(
  array: SqlArrayDefaultElement[],
  baseType: string,
  depth: number,
  budget: RenderBudget
): string {
  if (depth >= MAX_SQL_ARRAY_DEFAULT_DEPTH) {
    failUnbounded("depth", { depth, max: MAX_SQL_ARRAY_DEFAULT_DEPTH });
  }
  if (budget.ancestors.has(array)) {
    failUnbounded("cycle", { depth });
  }
  if (array.length > MAX_SQL_ARRAY_DEFAULT_ELEMENTS - budget.elements) {
    failUnbounded("elements", {
      elements: budget.elements + array.length,
      max: MAX_SQL_ARRAY_DEFAULT_ELEMENTS,
    });
  }
  budget.elements += array.length;
  reserveChars(budget, Math.max(2, array.length + 1));
  budget.ancestors.add(array);
  try {
    const values = new Array<string>(array.length);
    for (let index = 0; index < array.length; index += 1) {
      if (!(index in array)) continue;
      const value = array[index];
      let rendered: string;
      if (typeof value === "number" || typeof value === "bigint") {
        rendered = value.toString();
      } else if (typeof value === "boolean") {
        rendered = value ? "true" : "false";
      } else if (Array.isArray(value)) {
        values[index] = renderArray(value, baseType, depth + 1, budget);
        continue;
      } else if (value instanceof Date) {
        if (baseType === "date") {
          rendered = `"${value.toISOString().split("T")[0]}"`;
        } else if (baseType === "timestamp") {
          rendered = `"${value.toISOString().replace("T", " ").slice(0, 23)}"`;
        } else {
          rendered = `"${value.toISOString()}"`;
        }
      } else if (typeof value === "object") {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
          failUnbounded("chars", { reason: "object default is not JSON serializable" });
        }
        rendered = `"${serialized.replaceAll('"', '\\"')}"`;
      } else {
        if (
          typeof value === "string" &&
          value.length + 2 > MAX_SQL_ARRAY_DEFAULT_CHARS - budget.chars
        ) {
          failUnbounded("chars", {
            chars: budget.chars + value.length + 2,
            max: MAX_SQL_ARRAY_DEFAULT_CHARS,
          });
        }
        rendered = `"${value}"`;
      }
      reserveChars(budget, rendered.length);
      values[index] = rendered;
    }
    return `{${values.join(",")}}`;
  } finally {
    budget.ancestors.delete(array);
  }
}

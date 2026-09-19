/**
 * Request-boundary validation for strings that will be stored in PostgreSQL
 * text or jsonb columns. PostgreSQL rejects U+0000 in text (SQLSTATE 22021) and
 * in jsonb (22P05), and jsonb also rejects lone UTF-16 surrogates (22P02); a
 * route that lets such a value reach the insert answers 500 for what is a
 * malformed client request. These zod schemas turn that into a 400 whose issue
 * names the offending path.
 */
import { z } from "zod";

/**
 * Bound on the JSON values (objects, arrays, strings, scalars and keys) a
 * single free-form field may carry. None of the consuming routes registers a
 * body limit, so this is the documented size contract for those fields;
 * exceeding it is reported as its own outcome, never as an unstorable string.
 */
export const MAX_JSON_NODES = 50_000;

const NUL = String.fromCharCode(0);

/** True when every UTF-16 surrogate code unit is part of a valid pair. */
function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** True when PostgreSQL text and jsonb both accept the string as-is. */
export function isStorableString(value: string): boolean {
  if (value.includes(NUL)) return false;
  return isWellFormedUtf16(value);
}

/** Outcome of walking a JSON value for storability. */
export type StorableJsonInspection =
  | { kind: "storable" }
  | { kind: "unstorable"; path: (string | number)[] }
  | { kind: "too-large"; limit: number };

class JsonNodeBudgetExceeded extends Error {}

/**
 * Walks parsed JSON and reports the first key or string value PostgreSQL would
 * reject, that the value exceeds `MAX_JSON_NODES`, or that it is storable. The
 * three outcomes are distinct so an oversized but clean payload is never
 * reported as containing an unstorable string.
 */
export function inspectStorableJson(
  value: unknown,
  path: readonly (string | number)[] = [],
): StorableJsonInspection {
  let budget = MAX_JSON_NODES;
  const visit = (node: unknown, at: (string | number)[]): (string | number)[] | null => {
    budget -= 1;
    if (budget < 0) throw new JsonNodeBudgetExceeded();
    if (typeof node === "string") return isStorableString(node) ? null : at;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const hit = visit(node[index], [...at, index]);
        if (hit) return hit;
      }
      return null;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (!isStorableString(key)) return [...at, key];
        const hit = visit(child, [...at, key]);
        if (hit) return hit;
      }
    }
    return null;
  };
  try {
    const hit = visit(value, [...path]);
    return hit ? { kind: "unstorable", path: hit } : { kind: "storable" };
  } catch (error) {
    // error-policy:J3 the budget signal is this module's own control flow;
    // it becomes the explicit too-large outcome, never a fake-valid result.
    if (error instanceof JsonNodeBudgetExceeded) {
      return { kind: "too-large", limit: MAX_JSON_NODES };
    }
    throw error;
  }
}

/**
 * Path of the first unstorable key or string value, or null when the value is
 * storable. Throws when the value exceeds `MAX_JSON_NODES`, because "no
 * unstorable string found" would be untrue for a value that was not fully
 * walked; callers that must handle that case use `inspectStorableJson`.
 */
export function findUnstorableJsonPath(
  value: unknown,
  path: readonly (string | number)[] = [],
): (string | number)[] | null {
  const inspection = inspectStorableJson(value, path);
  if (inspection.kind === "too-large") {
    throw new RangeError(
      `JSON value exceeds the ${inspection.limit}-value storability bound and was not fully walked`,
    );
  }
  return inspection.kind === "unstorable" ? inspection.path : null;
}

const UNSTORABLE_STRING_MESSAGE = "must not contain U+0000 or lone surrogate code units";
const TOO_LARGE_MESSAGE = `must contain at most ${MAX_JSON_NODES} JSON values (objects, arrays, keys and scalars combined)`;

/** `z.string()` that also rejects values PostgreSQL text/jsonb cannot store. */
export function storableString() {
  return z.string().refine(isStorableString, UNSTORABLE_STRING_MESSAGE);
}

/**
 * `z.record(z.string(), z.unknown())` whose keys and nested string values are
 * all storable and whose size is within `MAX_JSON_NODES`; an unstorable entry
 * is reported at its path, an oversized value at the record itself with a
 * message naming the bound.
 */
export function storableJsonRecord() {
  return z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
    const inspection = inspectStorableJson(value);
    if (inspection.kind === "unstorable") {
      ctx.addIssue({
        code: "custom",
        message: UNSTORABLE_STRING_MESSAGE,
        path: inspection.path,
      });
    } else if (inspection.kind === "too-large") {
      ctx.addIssue({ code: "custom", message: TOO_LARGE_MESSAGE });
    }
  });
}

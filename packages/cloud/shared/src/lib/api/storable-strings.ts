/**
 * Request-boundary validation for strings that will be stored in PostgreSQL
 * text or jsonb columns. PostgreSQL rejects U+0000 in text (SQLSTATE 22021) and
 * in jsonb (22P05), and jsonb also rejects lone UTF-16 surrogates (22P02); a
 * route that lets such a value reach the insert answers 500 for what is a
 * malformed client request. These zod schemas turn that into a 400 whose issue
 * names the offending path.
 */
import { z } from "zod";

/** Bound on the values walked per request; JSON bodies are size-capped upstream. */
const MAX_JSON_NODES = 50_000;

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

/**
 * Walks parsed JSON and returns the path of the first key or string value
 * PostgreSQL would reject, or null when every string is storable.
 */
export function findUnstorableJsonPath(
  value: unknown,
  path: readonly (string | number)[] = [],
): (string | number)[] | null {
  let budget = MAX_JSON_NODES;
  const visit = (node: unknown, at: (string | number)[]): (string | number)[] | null => {
    budget -= 1;
    if (budget < 0) return at;
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
  return visit(value, [...path]);
}

const UNSTORABLE_STRING_MESSAGE = "must not contain U+0000 or lone surrogate code units";

/** `z.string()` that also rejects values PostgreSQL text/jsonb cannot store. */
export function storableString() {
  return z.string().refine(isStorableString, UNSTORABLE_STRING_MESSAGE);
}

/**
 * `z.record(z.string(), z.unknown())` whose keys and nested string values are
 * all storable; the issue path points at the first offending entry.
 */
export function storableJsonRecord() {
  return z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
    const hit = findUnstorableJsonPath(value);
    if (hit) {
      ctx.addIssue({
        code: "custom",
        message: UNSTORABLE_STRING_MESSAGE,
        path: hit,
      });
    }
  });
}

/**
 * What a failed job records about why it failed.
 *
 * Job rows stored `error.message` alone, so `agent_delete` failures have sat at
 * 35 bytes — "value.toISOString is not a function" — across 342 production
 * occurrences with nothing to locate the call site from (#23117). One of them
 * has been undeletable since 2026-07-07 for want of a stack.
 *
 * Bounded because the same column is already the wrong size in the other
 * direction: 33 rows exceed 100 KB from payload dumps, and a grouping query
 * over it failed outright with `invalid memory alloc request size 1130945444`.
 * Cutting on characters rather than bytes keeps multi-byte sequences intact.
 *
 * Three properties this module owes its callers, because the value it produces
 * is written to `jobs.error` and surfaced by the jobs API:
 *
 * - It never throws. `String(value)` throws for a null-prototype object and an
 *   `Error` can carry a throwing `stack` accessor; this runs *before* the
 *   failed job is written back, so a throw here would replace the original
 *   failure and strand the claimed job without its retry/failure transition.
 * - It redacts before the text becomes durable. The logger's redactor covers
 *   process logs only — nothing scrubs this DB path, and a stack can carry a
 *   credential from the frame that raised it.
 * - It caps at exactly `JOB_ERROR_MAX_CHARS`, suffix included.
 */

import { redactSensitiveText } from "@elizaos/core";

const JOB_ERROR_MAX_CHARS = 4_000;
const TRUNCATION_SUFFIX = "\n… truncated";
/** Wrapped throws are common here; deeper chains are noise in a job row. */
const MAX_CAUSE_DEPTH = 4;

/** Classify an untrusted throw without allowing Proxy reflection to escape. */
function safeError(value: unknown): Error | undefined {
  try {
    return value instanceof Error ? value : undefined;
  } catch {
    // error-policy:J3 a revoked or hostile Proxy can throw from getPrototypeOf.
    return undefined;
  }
}

/** Stringify anything without ever throwing (null-prototype, hostile toString). */
function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    // A thrown plain object (JSON-RPC error payloads are a live shape on this
    // path) stringifies to "[object Object]" — as information-free as the rows
    // this module exists to fix. Serialize it instead.
    if (
      value !== null &&
      typeof value === "object" &&
      !safeError(value) &&
      typeof (value as { toString?: unknown }).toString !== "function"
    ) {
      const json = JSON.stringify(value);
      if (typeof json === "string") return json;
    }
    const coerced = String(value);
    if (coerced === "[object Object]") {
      const json = JSON.stringify(value);
      if (typeof json === "string" && json !== "{}") return json;
    }
    return coerced;
  } catch {
    // error-policy:J3 untrusted throw value; an unstringifiable one yields an
    // explicit marker rather than propagating over the original failure.
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "[unstringifiable]";
    }
  }
}

/** `error.stack` is an accessor and can throw or be a non-string. */
function safeStack(error: Error): string {
  try {
    const stack = error.stack;
    if (typeof stack === "string" && stack.trim().length > 0) {
      return stack.trim();
    }
  } catch {
    // error-policy:J3 hostile stack accessor; fall through to the message.
  }
  try {
    return typeof error.message === "string" && error.message.length > 0
      ? error.message
      : safeString(error);
  } catch {
    return "[unreadable error]";
  }
}

/**
 * Native stacks do not serialize `cause`, so a wrapped throw loses exactly the
 * lower-level detail this module exists to retain. Bounded by depth and
 * cycle-safe: `cause` chains can loop.
 */
function describeErrorChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    // Only the cause traversal skips nullish; a job that threw `null`
    // must still record "null" rather than an empty column.
    if (depth > 0 && (current === undefined || current === null)) break;
    if (typeof current === "object" && seen.has(current)) {
      parts.push("caused by: [circular]");
      break;
    }
    if (typeof current === "object") seen.add(current);

    const currentError = safeError(current);
    const text = currentError ? safeStack(currentError) : safeString(current);
    parts.push(depth === 0 ? text : `caused by: ${text}`);

    if (!currentError) break;
    let next: unknown;
    try {
      next = (currentError as { cause?: unknown }).cause;
    } catch {
      // error-policy:J3 hostile cause accessor ends the chain rather than
      // replacing the failure being recorded.
      break;
    }
    if (next === undefined) break;
    if (depth === MAX_CAUSE_DEPTH) {
      parts.push("caused by: [depth limit reached]");
      break;
    }
    current = next;
  }

  return parts.join("\n");
}

/**
 * Redact and cap any job-error text. Exported so every branch that persists to
 * `jobs.error` — including pre-formatted ones that bypass `jobErrorText` — ends
 * at the same ceiling with the same scrubbing.
 */
export function finalizeJobErrorText(text: string): string {
  let redacted: string;
  try {
    redacted = redactSensitiveText(text);
  } catch {
    // error-policy:J3 the module's contract is that it never throws — this is
    // its one external call, and it runs before the failed job is written
    // back. A redactor failure must not strand the job, and unredacted text
    // must not become durable, so record the failure instead of the text.
    redacted = "[error text withheld: redaction failed]";
  }
  if (redacted.length <= JOB_ERROR_MAX_CHARS) return redacted;
  const room = JOB_ERROR_MAX_CHARS - TRUNCATION_SUFFIX.length;
  return `${redacted.slice(0, room)}${TRUNCATION_SUFFIX}`;
}

export function jobErrorText(error: unknown): string {
  return finalizeJobErrorText(describeErrorChain(error));
}

/**
 * One-line summary of a throw, for embedding in another error's message.
 * Never throws; carries no frames, so wrapping does not consume the budget
 * the wrapped error's own `cause` will need.
 */
export function jobErrorSummary(error: unknown): string {
  const classifiedError = safeError(error);
  const text = classifiedError
    ? (() => {
        try {
          return typeof classifiedError.message === "string" && classifiedError.message.length > 0
            ? classifiedError.message
            : safeString(classifiedError);
        } catch {
          // error-policy:J3 hostile message accessor.
          return "[unreadable error]";
        }
      })()
    : safeString(error);
  return (text.split("\n", 1)[0] ?? "").trim() || "[no error text]";
}

/**
 * What the jobs API may return to a caller. The stored text is an operator
 * diagnostic: even redacted it discloses absolute server paths and internal
 * module layout, which a non-admin job owner has no business reading. Keep the
 * first line — the failure summary — and drop the frames.
 */
export function publicJobErrorSummary(storedError: string | null | undefined): string | null {
  if (typeof storedError !== "string") return null;
  // Split on the frame marker rather than the first newline: an error message
  // can itself be multi-line ("Provisioning failed:\nnode: …\nreason: …") and
  // the owner needs that body — it is the frames that disclose server layout.
  const summary = (storedError.split(/\n\s+at /, 1)[0] ?? "").trim();
  return summary.length > 0 ? summary : null;
}

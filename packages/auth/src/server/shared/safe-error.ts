/**
 * safe-error.ts — a non-throwing description of an ARBITRARY thrown value.
 *
 * WHY THIS EXISTS (fail-closed at catch boundaries)
 * -------------------------------------------------
 * A `catch (err)` boundary that fails closed (deny) is only actually fail-closed
 * if BUILDING the deny reason cannot itself throw. The naive idiom
 *
 *     err instanceof Error ? err.message : String(err)
 *
 * is NOT safe against a hostile or nonstandard thrown value:
 *
 *   - `String(err)` invokes `err[Symbol.toPrimitive]` / `err.toString` /
 *     `err.valueOf`, ANY of which can throw. A probe as small as
 *     `throw { toString() { throw new Error("boom") } }` makes the catch block
 *     itself throw, unwinding PAST the fail-closed return and escaping as a raw
 *     500 — i.e. the exact opposite of fail-closed.
 *   - `err instanceof Error` is true for a `Proxy(new Error(), handler)` whose
 *     `get` trap throws, so even reading `err.message` after an `instanceof`
 *     check can throw.
 *   - `JSON.stringify(err)` walks getters and can throw / recurse / leak — never
 *     used here.
 *
 * CONTRACT
 * --------
 * `describeThrown(value)` ALWAYS returns a string and NEVER throws, for ANY
 * input. It returns a useful message for well-behaved Errors/strings, and a
 * static fallback for anything whose coercion misbehaves. Every coercion step is
 * individually guarded; the outermost guard guarantees the static fallback even
 * if something we did not anticipate throws.
 */

/** Last-resort description when every coercion of the thrown value misbehaves. */
export const UNPRINTABLE_THROWN_VALUE =
  "policy evaluator threw an unprintable value";

export interface RedactedThrownDiagnostics {
  errorClass: string;
  errorCode: string | null;
}

const SAFE_ERROR_CODES = new Set([
  "ABORT_ERR",
  "DB_TLS_REQUIRED",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Return bounded, non-secret diagnostics for logs at credential boundaries.
 * Both `instanceof` and property access are guarded because hostile proxies can
 * throw from either operation. Arbitrary error names and codes are never
 * returned: names and arbitrary machine-looking codes can contain secrets, so
 * codes are limited to a fixed allowlist of transport failures.
 */
export function redactedThrownDiagnostics(
  value: unknown,
): RedactedThrownDiagnostics {
  let errorClass: string = typeof value;
  try {
    if (value instanceof Error) errorClass = "Error";
  } catch {
    errorClass = "object";
  }

  let errorCode: string | null = null;
  try {
    if (
      value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      "code" in value
    ) {
      const candidate = (value as { code?: unknown }).code;
      if (typeof candidate === "string" && SAFE_ERROR_CODES.has(candidate)) {
        errorCode = candidate;
      }
    }
  } catch {
    // A hostile proxy/getter is intentionally reduced to the fixed fallback.
  }

  return { errorClass, errorCode };
}

/**
 * Try to read a hostile-safe `.message` off a value that claims to be an Error.
 * The property access itself can throw (Proxy get-trap / throwing getter), so it
 * is wrapped. Returns a non-empty trimmed string, or `undefined` if the message
 * is absent, non-string, empty, or the access threw.
 */
function tryErrorMessage(value: object): string | undefined {
  try {
    // Deliberately NOT `value instanceof Error &&` gated: `instanceof` on a
    // Proxy can invoke a trap, and we already know `value` is an object here.
    // Read defensively; a throwing getter lands in the catch below.
    const msg = (value as { message?: unknown }).message;
    if (typeof msg === "string") {
      const trimmed = msg.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  } catch {
    // hostile getter / proxy trap — fall through to undefined.
  }
  return undefined;
}

/**
 * Try to coerce a value to string via `String(...)`. This invokes
 * `Symbol.toPrimitive` / `toString` / `valueOf`, any of which can throw or
 * return a non-string. Returns a non-empty string, or `undefined` if coercion
 * threw or produced nothing useful.
 */
function tryStringCoerce(value: unknown): string | undefined {
  try {
    const s = String(value);
    if (typeof s === "string") {
      const trimmed = s.trim();
      // "[object Object]" is technically a string but carries no signal; still
      // return it rather than the static fallback — it is at least honest about
      // the shape and cannot itself be hostile.
      return trimmed.length > 0 ? trimmed : undefined;
    }
  } catch {
    // hostile toString/valueOf/Symbol.toPrimitive — fall through.
  }
  return undefined;
}

/**
 * Describe an arbitrary thrown value as a string, NEVER throwing.
 *
 * Order of preference:
 *   1. a well-behaved string `.message` (typical Error), else
 *   2. a `String(...)` coercion (typical primitives, custom stringifiers), else
 *   3. the static {@link UNPRINTABLE_THROWN_VALUE} fallback.
 *
 * The whole body is additionally wrapped so that an unanticipated throw (e.g. a
 * `typeof` on an exotic proxy) still yields the static fallback.
 */
export function describeThrown(value: unknown): string {
  try {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : UNPRINTABLE_THROWN_VALUE;
    }
    if (value !== null && typeof value === "object") {
      const fromMessage = tryErrorMessage(value);
      if (fromMessage !== undefined) return fromMessage;
    }
    const coerced = tryStringCoerce(value);
    if (coerced !== undefined) return coerced;
    return UNPRINTABLE_THROWN_VALUE;
  } catch {
    // Absolute backstop: nothing above is allowed to escape.
    return UNPRINTABLE_THROWN_VALUE;
  }
}

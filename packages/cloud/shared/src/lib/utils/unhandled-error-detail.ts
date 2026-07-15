/**
 * Plain-object summary of an unhandled error for structured worker logs.
 *
 * Why this exists (#16145): the `[CloudApi] Unhandled error` log passed the
 * raw `Error` to the logger, and the core log-sink redactor
 * (`redactLogArgs` → its `instanceof Error` branch) rebuilds errors as a bare
 * `new Error(...)` whose `message`/`stack` are NON-enumerable. Cloudflare's
 * JSON tail serializes enumerable properties only, so every unhandled 500
 * surfaced as `{"error":{"name":"ElizaError"}}` — no message, no `code`, no
 * cause. Diagnosing the staging KMS misconfiguration required reverse
 * engineering the whole create path instead of reading one tail line.
 *
 * The fix is structural: extract the diagnostic fields into a plain object,
 * whose string values the redaction sink still scrubs (`redactSensitiveText`)
 * and whose keys still pass `isSensitiveKeyName` masking — so nothing new can
 * leak, but `message`, `code`, `severity`, `context`, and one level of `cause`
 * survive JSON serialization.
 *
 * Structural (no `ElizaError` import): the Worker bundle aliases
 * `@elizaos/core` to a stub, so `instanceof` checks against either class are
 * unreliable across that boundary. Reading optional fields by shape works for
 * core's ElizaError, the stub's mirror, `KmsError` (`status`), and pg errors
 * (SQLSTATE `code`).
 */

/**
 * Stringify a non-Error throw without ever throwing ourselves: this module
 * sits on the global error boundary, and `String(value)` can itself throw
 * (null-prototype objects, hostile `toString`). Logging must never replace
 * the original 500 handling.
 */
function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "[unstringifiable]";
    }
  }
}

/** One level of `cause` summary — enough to see through a wrapped throw. */
function describeCause(cause: unknown): Record<string, unknown> | string {
  if (cause instanceof Error) {
    const out: Record<string, unknown> = {
      name: cause.name,
      message: cause.message,
    };
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") out.code = code;
    return out;
  }
  return safeString(cause);
}

/**
 * Summarize an unhandled error as a plain enumerable object for JSON log
 * sinks. Never throws.
 */
export function describeUnhandledError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { value: safeString(err) };
  }

  const out: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  };

  // ElizaError classification / pg SQLSTATE — both live on `code`.
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") out.code = code;

  // ElizaError transient-vs-fatal hint.
  const severity = (err as { severity?: unknown }).severity;
  if (typeof severity === "string") out.severity = severity;

  // KmsError carries the backend HTTP status.
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") out.status = status;

  // ElizaError diagnostic context — the log-sink redactor masks sensitive
  // keys and scrubs string values, so this passes through the same policy as
  // any other logged object.
  const context = (err as { context?: unknown }).context;
  if (context !== null && typeof context === "object" && !Array.isArray(context)) {
    out.context = context;
  }

  if (err.cause !== undefined) {
    out.cause = describeCause(err.cause);
  }

  return out;
}

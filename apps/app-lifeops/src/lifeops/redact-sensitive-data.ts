/**
 * Redact PII / secrets from arbitrary nested values before they land in
 * audit-event payloads or error logs.
 *
 * The redactor walks the value depth-first and replaces any string assigned
 * to a sensitive key with a placeholder. Email-looking substrings are also
 * redacted in otherwise non-sensitive strings so audit context remains useful
 * without leaking arbitrary addresses. Long subjects / bodies are truncated to
 * a fixed prefix after PII redaction so an audit trail still has enough context
 * to debug, but cannot be used to leak the full message body.
 *
 * Sensitive key names (matched case-insensitively, exact name OR substring
 * for the obvious credential terms):
 *
 *   - body, snippet, subject, fromEmail, toList, to, from, email
 *   - password, token, secret, apiKey, authorization
 */

const REDACTED = "[REDACTED]";
const REDACTED_EMAIL = "[REDACTED_EMAIL]";
const DEFAULT_SUBJECT_PREVIEW = 20;
const DEFAULT_BODY_PREVIEW = 30;
const EMAIL_ADDRESS_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const FULL_REDACT_KEYS = new Set([
  "password",
  "token",
  "secret",
  "apikey",
  "api_key",
  "authorization",
]);

const EMAIL_LIKE_KEYS = new Set([
  "fromemail",
  "tolist",
  "to",
  "from",
  "email",
  "cc",
  "bcc",
  "ccemail",
  "bccemail",
  "replyto",
]);

const SUBJECT_KEYS = new Set(["subject"]);
const BODY_KEYS = new Set(["body", "bodytext", "snippet", "preview"]);

/** Substring match for credential-ish keys we always want fully redacted. */
const FULL_REDACT_SUBSTRINGS = ["password", "secret", "apikey", "token"];

interface RedactOptions {
  readonly subjectPreview?: number;
  readonly bodyPreview?: number;
}

function isFullRedactKey(normalizedKey: string): boolean {
  if (FULL_REDACT_KEYS.has(normalizedKey)) return true;
  for (const needle of FULL_REDACT_SUBSTRINGS) {
    if (normalizedKey.includes(needle)) return true;
  }
  return false;
}

function shortenSubject(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}…`;
}

function shortenBody(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}… [+${value.length - max} chars]`;
}

function redactEmailAddresses(value: string): string {
  return value.replace(EMAIL_ADDRESS_PATTERN, REDACTED_EMAIL);
}

function redactString(
  rawKey: string,
  value: string,
  opts: RedactOptions,
): string {
  const key = rawKey.toLowerCase();
  if (isFullRedactKey(key)) {
    return REDACTED;
  }
  if (EMAIL_LIKE_KEYS.has(key)) {
    return REDACTED;
  }
  const valueWithoutEmails = redactEmailAddresses(value);
  if (SUBJECT_KEYS.has(key)) {
    return shortenSubject(
      valueWithoutEmails,
      opts.subjectPreview ?? DEFAULT_SUBJECT_PREVIEW,
    );
  }
  if (BODY_KEYS.has(key)) {
    return shortenBody(
      valueWithoutEmails,
      opts.bodyPreview ?? DEFAULT_BODY_PREVIEW,
    );
  }
  return valueWithoutEmails;
}

function redactValue(
  rawKey: string,
  value: unknown,
  opts: RedactOptions,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactString(rawKey, value, opts);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    // Arrays use the parent key for redaction context (e.g. `toList: [...]`).
    return value.map((entry) => redactValue(rawKey, entry, opts, seen));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = redactValue(k, v, opts, seen);
    }
    return out;
  }
  // numbers / booleans / bigint / symbol — pass through unchanged.
  return value;
}

/**
 * Redact a value (object, array, or primitive) for safe inclusion in audit
 * events or log lines. Strings under sensitive keys are replaced with a
 * placeholder; subjects/bodies are truncated.
 *
 * The function is non-mutating — callers receive a fresh structure and the
 * input value is left intact.
 */
export function redactSensitiveData<T>(value: T, opts: RedactOptions = {}): T {
  return redactValue("", value, opts, new WeakSet()) as T;
}

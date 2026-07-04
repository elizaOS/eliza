/**
 * Single classifier for config keys whose values must be treated as secrets.
 *
 * This is intentionally separate from BLOCKED_ENV_KEYS: blocked keys are
 * injection/persistence policy, while this predicate controls redaction and UI
 * sensitivity hints for arbitrary config paths.
 */
const SENSITIVE_CONFIG_KEY_RE =
  /password|secret|api.?key|private.?key|seed.?phrase|authorization|connection.?string|credential|tokens?$/i;

export function isSensitiveConfigKey(key: string): boolean {
  const lastSegment = key.split(".").at(-1) ?? key;
  const normalized = lastSegment.replace(/[-_\s]/g, "").toLowerCase();
  if (/^maxtokens?$/.test(normalized)) return false;
  return SENSITIVE_CONFIG_KEY_RE.test(key);
}

/**
 * Window-title PII redactor for the T8d activity tracker.
 *
 * Always stripped before reporting:
 *  - Email addresses          → [redacted-email]
 *  - Phone numbers (e.164 / 10-digit US)  → [redacted-phone]
 *  - Card-shaped runs of at least 12 decimal digits, including Unicode separators → [redacted-cc]
 *
 * Redaction is applied in the reporting layer before results leave the
 * process.
 */

const EMAIL = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g;

// Redact the entire run, including appended expiry/CVV digits. Horizontal
// separators, Unicode formatting, and combining marks must not split a PAN.
// One character class avoids overlapping-alternative backtracking.
const CC_LIKE =
  /\p{Nd}(?:[\t \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000.,/\uFF0E\uFF0C\uFF0F\u2044\u2215\p{Pd}\u2212\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}]*\p{Nd}){11,}/gu;

// Phone: e.164 (+ followed by 7-15 digits), or 10-digit US formats with an
// optional +1 country code and separators.
const PHONE =
  /(?<!\d)(?:\+\d{7,15}|(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})(?!\d)/g;

export type RedactorConfig = Record<string, never>;

export function resolveRedactorConfigFromEnv(
  _env: NodeJS.ProcessEnv = process.env,
): RedactorConfig {
  return {};
}

export function redactWindowTitle(
  title: string | null | undefined,
  _config: RedactorConfig,
): string | null {
  if (title === null || title === undefined) return null;
  let out = title;
  // Preserve whole email matches before their numeric local parts are redacted.
  out = out.replace(EMAIL, "[redacted-email]");
  out = out.replace(CC_LIKE, "[redacted-cc]");
  out = out.replace(PHONE, "[redacted-phone]");
  return out;
}

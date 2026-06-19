/**
 * Window-title PII redactor for the T8d activity tracker.
 *
 * Always stripped before reporting:
 *  - Email addresses          → [redacted-email]
 *  - Phone numbers (e.164 / 10-digit US)  → [redacted-phone]
 *  - Credit-card-like digit runs (13–19 contiguous digits, optional separators) → [redacted-cc]
 *
 * Redaction is applied in the reporting layer before results leave the
 * process.
 */

const EMAIL = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g;

// Credit-card-like digit runs. Checked BEFORE phone numbers because a 16-digit
// PAN would otherwise be partially matched by the phone regex.
const CC_LIKE = /(?:\d[ -]?){13,19}/g;

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
  out = out.replace(CC_LIKE, (match) => {
    const digitCount = (match.match(/\d/g) ?? []).length;
    return digitCount >= 13 && digitCount <= 19 ? "[redacted-cc]" : match;
  });
  out = out.replace(EMAIL, "[redacted-email]");
  out = out.replace(PHONE, "[redacted-phone]");
  return out;
}

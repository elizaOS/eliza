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
// PAN would otherwise be partially matched by the phone regex. Separators are
// allowed only BETWEEN digits, at most one per gap (never trailing, so
// surrounding text like the space before "(555)" is preserved, and dense
// numeric titles with multi-character separators are not over-redacted). The
// final \d sits outside the repetition so a match never ends on a separator.
const CC_LIKE = /(?:\d[ \t-]?){12,18}\d/g;

// Grouped PANs: digit groups of 3–6 (the group sizes that occur in standard
// PAN layouts — 4-3-3-3, 4-4-4-4, 4-6-5, 4-4-4-4-3 — e.g. a spreadsheet paste
// with doubled spaces/tabs, which CC_LIKE's one-separator-per-gap rule skips).
// The whole run is consumed as a single match (never a partial 16-digit
// substring of a longer run), then digit-counted 13–19 like CC_LIKE: a
// recognizable Visa/Mastercard/Amex PAN never leaves the process in cleartext,
// while 1–2-digit numeric lists ("12  7  93  4  55"), 10-digit phones, and
// 20+-digit runs are left untouched (no partial redaction).
const GROUPED_PAN = /(?:\d{3,6}[ \t-]{1,2})+\d{3,6}/g;

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

function redactCardRun(match: string): string {
  const digitCount = (match.match(/\d/g) ?? []).length;
  return digitCount >= 13 && digitCount <= 19 ? "[redacted-cc]" : match;
}

export function redactWindowTitle(
  title: string | null | undefined,
  _config: RedactorConfig,
): string | null {
  if (title === null || title === undefined) return null;
  let out = title;
  out = out.replace(GROUPED_PAN, redactCardRun);
  out = out.replace(CC_LIKE, redactCardRun);
  out = out.replace(EMAIL, "[redacted-email]");
  out = out.replace(PHONE, "[redacted-phone]");
  return out;
}

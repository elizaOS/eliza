/**
 * Window-title PII redactor for the T8d activity tracker.
 *
 * Always stripped before reporting:
 *  - Email addresses          → [redacted-email]
 *  - Phone numbers (e.164 / 10-digit US)  → [redacted-phone]
 *  - Digit runs of 12 or more digits (card-shaped or longer) → [redacted-cc]
 *
 * A run is decimal digits (\p{Nd} — ASCII, Arabic-Indic, fullwidth, and
 * every other Unicode decimal script, so a localized PAN spelling cannot
 * bypass the pass) joined by horizontal separators — space, tab, NBSP and
 * other unicode spaces, dot, comma, slash (and its homoglyphs U+2044/
 * U+2215), any Unicode dash punctuation (\p{Pd}), minus sign, and ANY
 * invisible or combining mark (\p{Cf} format characters, every
 * default-ignorable code point, and \p{M} combining marks — no
 * formatting or combining mark can split a PAN into sub-13 fragments) —
 * with any number of separators between two digits ("4111 - 1111" and
 * "4111  1111" are card-shaped too).
 * Vertical whitespace and any other character break a run, so digit groups
 * on different lines of a title never combine. Runs longer than 19 digits are redacted
 * in full: a maximal match may be a valid PAN concatenated with another
 * numeric field (e.g. "4111 1111 1111 1111/2024" — a 16-digit PAN plus an
 * expiry), and passing such a match through would leak the embedded PAN.
 * Over-redacting long order/tracking IDs is the accepted trade-off.
 *
 * Runs of 11 digits are left visible — 12 is the floor of the ISO/IEC 7812
 * PAN length range (Maestro has historically issued 12-digit PANs), so a
 * 12-digit run redacts. This over-redacts some 12-digit invoice/reference
 * numbers; failing closed is the accepted trade-off, because a report
 * consumer cannot distinguish a benign 12-digit reference from a PAN after
 * this boundary has declared the title safe.
 *
 * Redaction is applied in the reporting layer before results leave the
 * process.
 */

const EMAIL = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g;

// Credit-card-like digit runs. Checked BEFORE phone numbers because a 16-digit
// PAN would otherwise be partially matched by the phone regex. \p{Nd} matches
// every Unicode decimal digit (ASCII, Arabic-Indic, fullwidth, ...), so a
// localized PAN spelling cannot bypass the pass. Horizontal separators only —
// \p{Pd} covers every Unicode dash punctuation, plus minus (U+2212) and soft
// hyphen (U+00AD) — and any run of them may sit between two digits ("4111 -
// 1111", "4111  1111"). Newline and other vertical whitespace are not in the
// class, so they break a run; any non-separator character breaks it as well.
// U+200D ZWJ, every Unicode format character (\p{Cf}: soft hyphen, zero-width
// space/non-joiner, word joiner, BOM, bidi marks and isolates, Arabic letter
// mark), every default-ignorable code point (\p{Default_Ignorable_Code_Point}:
// variation selectors, combining grapheme joiner, Mongolian free variation
// selectors, ...), and combining marks (\p{M}) all sit in ONE character class:
// a class is atomic, so matching stays linear. An earlier shape used separate
// alternation branches whose overlapping memberships (ZWJ is Cf AND
// default-ignorable; variation selectors are M AND default-ignorable) caused
// exponential backtracking on near-matches (ReDoS — 25 repeated U+200B after
// the first digit of an 11-digit run took 16.5s). A regression test pins
// linear-time completion of that exact shape.
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
  // Any 12+ digit run is redacted whole. There is deliberately no upper
  // bound: a maximal match may embed a valid PAN next to another numeric
  // field (PAN + expiry, PAN + CVV), and exempting long matches would leak
  // the embedded PAN. See the header for the full rationale.
  out = out.replace(CC_LIKE, "[redacted-cc]");
  out = out.replace(EMAIL, "[redacted-email]");
  out = out.replace(PHONE, "[redacted-phone]");
  return out;
}

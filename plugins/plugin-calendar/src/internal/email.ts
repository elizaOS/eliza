/**
 * Lightweight structural email check for the event-editor attendee field.
 * Accepts the same shape as `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` — a non-empty local
 * part, exactly one `@`, and a domain carrying an interior dot — but computes it
 * with index/slice scans instead of that regex's adjacent `[^\s@]+ \. [^\s@]+`
 * quantifiers, which backtrack O(n²) on a no-whitespace, single-`@` value whose
 * domain is a long run of dots ending in a match-breaking character. Attendee
 * values can come from externally-synced calendar events, so that quadratic
 * blowup is a ReDoS vector; this stays linear.
 */
export function basicEmailValid(value: string): boolean {
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  if (/\s/.test(value)) return false;
  const domain = value.slice(at + 1);
  return domain.slice(1, -1).includes(".");
}

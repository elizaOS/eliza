/**
 * Lightweight structural email check. Accepts the same shape as
 * `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`: a non-empty local part, exactly one `@`, and
 * a domain carrying an interior dot. Uses scans instead of adjacent quantified
 * regex groups so adversarial dotted domains stay linear.
 */
export function basicEmailValid(value: string): boolean {
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  if (/\s/.test(value)) return false;
  const domain = value.slice(at + 1);
  return domain.slice(1, -1).includes(".");
}

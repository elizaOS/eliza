/**
 * Lightweight structural email checks for form validation. They use scans
 * instead of adjacent quantified regex groups so adversarial dotted domains stay
 * linear while preserving the historical difference between loose built-in
 * controls and stricter field validation.
 */
export function basicEmailValid(value: string): boolean {
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  if (/\s/.test(value)) return false;
  const domain = value.slice(at + 1);
  return domain.slice(1, -1).includes(".");
}

export function strictEmailValid(value: string): boolean {
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  if (/\s/.test(value)) return false;

  const domain = value.slice(at + 1);
  let sawDot = false;
  let labelLength = 0;
  for (const char of domain) {
    if (char === ".") {
      if (labelLength === 0) return false;
      sawDot = true;
      labelLength = 0;
    } else {
      labelLength += 1;
    }
  }

  return sawDot && labelLength > 0;
}

/**
 * Extracts email-like address tokens with monotonic scans so hostile sender
 * headers cannot trigger regex retry storms.
 */

function isAsciiLetterOrDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isAsciiLetter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiLocalCharacter(character: string): boolean {
  // RFC 5322 atext and dot (without ` { | }): o'brien and ops&dev are whole
  // local parts, not the suffix after the punctuation.
  return (
    isAsciiLetterOrDigit(character) || ".!#$%&'*+/=?^_~-".includes(character)
  );
}

function isAsciiDomainCharacter(character: string): boolean {
  return (
    isAsciiLetterOrDigit(character) || character === "." || character === "-"
  );
}

/**
 * RFC 5322 puts the authoritative address in the angle-addr (`<...>`), while
 * the display name before it is attacker-controlled free text. Scanning
 * angle spans first keeps `displayed@wrong.example <real@sender.example>`
 * resolving to the real sender instead of the spoofed display token.
 */
function extractAddress(
  value: string,
  extractToken: (span: string) => string | null,
): string | null {
  if (!value.includes("<") && !value.includes(">")) {
    return extractToken(value);
  }
  // Invalid angle syntax must not fall back to the display name.
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const open = value.indexOf("<", searchFrom);
    if (open < 0) return null;
    const close = value.indexOf(">", open + 1);
    if (close < 0) return null;
    const address = extractToken(value.slice(open + 1, close));
    if (address) return address;
    searchFrom = close + 1;
  }
  return null;
}

export function extractAsciiEmailAddress(value: string): string | null {
  return extractAddress(value, extractAsciiEmailToken);
}

function extractAsciiEmailToken(value: string): string | null {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const at = value.indexOf("@", searchFrom);
    if (at < 0) return null;
    let start = at;
    while (start > 0 && isAsciiLocalCharacter(value[start - 1] ?? ""))
      start -= 1;
    // A quote around a bare address is not part of it.
    while (start < at && value[start] === "'") start += 1;
    let end = at + 1;
    while (end < value.length && isAsciiDomainCharacter(value[end] ?? ""))
      end += 1;
    const domain = value.slice(at + 1, end);
    const dot = domain.lastIndexOf(".");
    if (
      start < at &&
      // A non-ASCII local part is not cut down to its ASCII suffix.
      !(start > 0 && value.charCodeAt(start - 1) > 0x7f) &&
      dot > 0 &&
      !domain.startsWith(".") &&
      domain.length - dot - 1 >= 2 &&
      [...domain.slice(dot + 1)].every(isAsciiLetter)
    ) {
      return value.slice(start, end).toLowerCase();
    }
    searchFrom = at + 1;
  }
  return null;
}

function isLooseAddressCharacter(character: string): boolean {
  return (
    character !== "@" &&
    !"<>()\"';,".includes(character) &&
    character.trim() !== ""
  );
}

export function extractLooseEmailAddress(value: string): string | null {
  return extractAddress(value, extractLooseEmailToken);
}

function extractLooseEmailToken(value: string): string | null {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const at = value.indexOf("@", searchFrom);
    if (at < 0) return null;
    let start = at;
    while (start > 0 && isLooseAddressCharacter(value[start - 1] ?? ""))
      start -= 1;
    let end = at + 1;
    while (end < value.length && isLooseAddressCharacter(value[end] ?? ""))
      end += 1;
    const candidate = value.slice(start, end);
    const domain = candidate.slice(candidate.indexOf("@") + 1);
    if (
      start < at &&
      domain.includes(".") &&
      !domain.startsWith(".") &&
      !domain.endsWith(".")
    ) {
      return candidate.toLowerCase();
    }
    searchFrom = at + 1;
  }
  return null;
}

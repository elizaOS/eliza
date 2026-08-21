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
  return isAsciiLetterOrDigit(character) || "._%+-".includes(character);
}

function isAsciiDomainCharacter(character: string): boolean {
  return (
    isAsciiLetterOrDigit(character) || character === "." || character === "-"
  );
}

export function extractAsciiEmailAddress(value: string): string | null {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const at = value.indexOf("@", searchFrom);
    if (at < 0) return null;
    let start = at;
    while (start > 0 && isAsciiLocalCharacter(value[start - 1] ?? ""))
      start -= 1;
    let end = at + 1;
    while (end < value.length && isAsciiDomainCharacter(value[end] ?? ""))
      end += 1;
    const domain = value.slice(at + 1, end);
    const dot = domain.lastIndexOf(".");
    if (
      start < at &&
      dot > 0 &&
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

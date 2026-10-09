import { NativeHostError } from "./errors.mjs";

const DIGIT_WORDS = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};
const SPOKEN_DIGITS =
  /\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)(?:[\s,.-]+(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)){3,}\b/gi;
/** Speech recognition writes "one two three four" or "1 2 3 4" for a spoken code. */
const spokenDigits = (text) =>
  text.replace(SPOKEN_DIGITS, (run) =>
    run
      .split(/[\s,.-]+/)
      .map((word) => DIGIT_WORDS[word.toLowerCase()])
      .join(""),
  );
/** Conservative recognition, not a promise to identify every possible secret.
 * Reject the whole input rather than silently changing a user's instructions.
 * Never include the matched value in an error or a log.
 */
export function containsSensitiveText(value) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
  const spoken = spokenDigits(normalized);
  return sensitive(normalized) || (spoken !== normalized && sensitive(spoken));
}
function sensitive(text) {
  if (
    /\b(?:csk-|sk-(?:proj-|live-)?|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{16,}\b/.test(
      text,
    )
  )
    return true;
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))
    return true;
  if (/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i.test(text)) return true;
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(text))
    return true;
  if (
    /\b(?:password|passphrase|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret)\s*(?:is\s+|=\s*|:\s*)\S+/i.test(
      text,
    )
  )
    return true;
  if (
    /\b(?:verification|security|one[ -]?time|confirmation|login|sign[ -]?in|authentication)\s+(?:code|pin)\s*(?:(?:is|was)\s*|[:=]\s*)?\d(?:[\s-]?\d){3,9}\b/i.test(
      text,
    )
  )
    return true;
  if (/\b(?:otp|pin|cvv|cvc)\s*(?:is\s+|[:=]\s*)\d{3,10}\b/i.test(text))
    return true;
  // Bare short codes are commonly pasted from verification messages.
  // Speech recognition may space the digits ("1 2 3 4"). Amounts such as
  // "12.50" or "1,000" are not codes.
  if (/^\s*\d(?:[ -]?\d){3,7}\s*[.!?]?\s*$/.test(text)) return true;
  for (const candidate of text.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    const digits = candidate[0].replace(/\D/g, "");
    if (/^(\d)\1+$/.test(digits)) continue;
    let sum = 0;
    for (
      let i = digits.length - 1, alternate = false;
      i >= 0;
      i--, alternate = !alternate
    ) {
      let n = Number(digits[i]);
      if (alternate) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

export function requireNonSensitiveText(text) {
  if (containsSensitiveText(text))
    throw new NativeHostError(
      "This looks like a password, verification code, token or card number. It was not sent. Remove it from your draft and enter it directly in the website or password manager.",
      { status: 422, code: "SENSITIVE_TEXT" },
    );
}

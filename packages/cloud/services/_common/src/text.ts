/**
 * Surrogate-safe text helpers for service diagnostics (leaf-local copy
 * to avoid pulling @elizaos/core into the webhook Docker bundle).
 * Well-formed truncation prevents lone-surrogate \uD8xx escapes and
 * split emoji in provider error diagnostics.
 */
const HIGH_START = 0xd800;
const HIGH_END = 0xdbff;
const LOW_START = 0xdc00;
const LOW_END = 0xdfff;
const REPLACEMENT = "�";
function isHigh(c: number): boolean {
  return c >= HIGH_START && c <= HIGH_END;
}
function isLow(c: number): boolean {
  return c >= LOW_START && c <= LOW_END;
}
function replaceLone(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const codeUnit = text.charCodeAt(index);
    if (isHigh(codeUnit)) {
      if (index + 1 < text.length && isLow(text.charCodeAt(index + 1))) {
        out += text.charAt(index) + text.charAt(index + 1);
        index++;
      } else {
        out += REPLACEMENT;
      }
    } else if (isLow(codeUnit)) {
      out += REPLACEMENT;
    } else {
      out += text.charAt(index);
    }
  }
  return out;
}
export function toWellFormedUnicode(text: string): string {
  const toWellFormed = (
    String.prototype as { toWellFormed?: (this: string) => string }
  ).toWellFormed;
  if (toWellFormed) return toWellFormed.call(text);
  const isWellFormed = (
    String.prototype as { isWellFormed?: (this: string) => boolean }
  ).isWellFormed;
  if (isWellFormed?.call(text)) return text;
  return replaceLone(text);
}
export function truncateWellFormed(text: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0) return "";
  if (text.length <= max) return text;
  const end =
    isHigh(text.charCodeAt(max - 1)) && isLow(text.charCodeAt(max))
      ? max - 1
      : max;
  return text.slice(0, end);
}

/**
 * Surrogate-safe Unicode helpers for vault persistence.
 *
 * Vault is a leaf package and must not depend on `@elizaos/core`; this is a
 * minimal vendored copy of `toWellFormedUnicode` + `truncateWellFormed` so
 * `pglite-vault` can sanitize quarantine reasons without splitting surrogate
 * pairs or storing lone surrogates.
 */

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const REPLACEMENT_CHARACTER = "�";

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;
}

const nativeToWellFormed = (
  String.prototype as { toWellFormed?: (this: string) => string }
).toWellFormed;
const nativeIsWellFormed = (
  String.prototype as { isWellFormed?: (this: string) => boolean }
).isWellFormed;

function replaceLoneSurrogates(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isHighSurrogate(code)) {
      if (i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
        out += text.charAt(i) + text.charAt(i + 1);
        i++;
      } else {
        out += REPLACEMENT_CHARACTER;
      }
    } else if (isLowSurrogate(code)) {
      out += REPLACEMENT_CHARACTER;
    } else {
      out += text.charAt(i);
    }
  }
  return out;
}

export function toWellFormedUnicode(text: string): string {
  if (nativeToWellFormed) {
    return nativeToWellFormed.call(text);
  }
  if (nativeIsWellFormed?.call(text)) {
    return text;
  }
  return replaceLoneSurrogates(text);
}

export function truncateWellFormed(text: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  const end =
    isHighSurrogate(text.charCodeAt(maxLength - 1)) &&
    isLowSurrogate(text.charCodeAt(maxLength))
      ? maxLength - 1
      : maxLength;
  return text.slice(0, end);
}

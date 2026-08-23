/**
 * Internal runtime validation helpers shared by vault implementations.
 */

import type { SetOptions } from "./vault-types.js";

export function assertKey(key: string): void {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new TypeError("vault: key must be a non-empty string");
  }
  if (key.length > 256) {
    throw new TypeError("vault: key must be 256 characters or fewer");
  }
}

export function optsCaller(opts: SetOptions): { caller?: string } {
  return opts.caller ? { caller: opts.caller } : {};
}

// Surrogate-safe truncation for audit reason (leaf-local copy of
// core well-formed helpers to avoid @elizaos/core dependency per
// master-key.ts leaf contract). Keeps truncated audit text well-formed
// so JSON never emits lone-surrogate \uD8xx escapes.
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const REPLACEMENT_CHARACTER = "�";
function isHighSurrogate(code: number): boolean { return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END; }
function isLowSurrogate(code: number): boolean { return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END; }
function replaceLoneSurrogates(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isHighSurrogate(code)) {
      if (i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) { out += text[i]! + text[i + 1]!; i++; } else { out += REPLACEMENT_CHARACTER; }
    } else if (isLowSurrogate(code)) { out += REPLACEMENT_CHARACTER; } else { out += text[i]!; }
  }
  return out;
}
export function toWellFormedUnicode(text: string): string {
  const nativeToWellFormed = (String.prototype as { toWellFormed?: (this: string) => string }).toWellFormed;
  if (nativeToWellFormed) return nativeToWellFormed.call(text);
  const nativeIsWellFormed = (String.prototype as { isWellFormed?: (this: string) => boolean }).isWellFormed;
  if (nativeIsWellFormed?.call(text)) return text;
  return replaceLoneSurrogates(text);
}
export function truncateWellFormed(text: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  const end = isHighSurrogate(text.charCodeAt(maxLength - 1)) && isLowSurrogate(text.charCodeAt(maxLength)) ? maxLength - 1 : maxLength;
  return text.slice(0, end);
}


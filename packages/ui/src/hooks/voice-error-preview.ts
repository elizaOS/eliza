/** Surrogate-safe preview formatting shared by voice failure and debug paths. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

export type VoiceErrorPreviewLimit = 80 | 120 | 200;

/** Normalize untrusted failure text and clamp it without splitting UTF-16 pairs. */
export function formatVoiceErrorPreview(
  value: unknown,
  limit: VoiceErrorPreviewLimit,
): string {
  const text = typeof value === "string" ? value : String(value);
  return truncateWellFormed(toWellFormedUnicode(text), limit);
}

/** Format a named Error through the same bounded, well-formed preview path. */
export function formatNamedVoiceError(error: unknown): string {
  return formatVoiceErrorPreview(
    error instanceof Error ? `${error.name}: ${error.message}` : error,
    200,
  );
}

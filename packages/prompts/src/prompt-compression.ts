/**
 * Preserves the legacy prompt-description helper as a lossless compatibility
 * alias. Runtime and code-generation paths use authored descriptions directly;
 * external callers that still import this symbol receive the complete string
 * byte-for-byte instead of a semantic rewrite.
 */

/**
 * @deprecated Prompt descriptions must be rendered directly. This identity
 * helper remains only to avoid breaking existing imports.
 */
export function compressPromptDescription(
  description: string | undefined,
): string {
  return typeof description === "string" ? description : "";
}

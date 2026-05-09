/**
 * Replace un-substituted `{{name}}` / `{{agentName}}` tokens with the
 * actual character name. Handles legacy persisted templates from onboarding.
 */
export function replaceNameTokens(text: string, name: string): string {
  return text
    .replace(/\{\{name\}\}/g, name)
    .replace(/\{\{agentName\}\}/g, name);
}

/**
 * Reverse of `replaceNameTokens` — rewrite whole-word occurrences of the
 * given literal character name back into `{{name}}` tokens so that a
 * later rename continues to propagate through every text field.
 *
 * Rules:
 * - Case-sensitive, whole-word match (word boundaries on both sides).
 * - Names under 2 characters are ignored; the tokenizer is not
 *   meaningful for single-letter names and risks destroying prose.
 * - Idempotent: re-running on already-tokenized text is a no-op because
 *   `{{name}}` does not contain the literal name.
 * - Non-destructive on empty input or empty name.
 *
 * @param text The text to scan.
 * @param name The literal character name to tokenize (e.g. "Momo").
 * @returns The text with whole-word occurrences replaced by `{{name}}`.
 */
export function tokenizeNameOccurrences(text: string, name: string): string {
  if (!text || !name) return text;
  const trimmed = name.trim();
  if (trimmed.length < 2) return text;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`, "g");
  return text.replace(pattern, "{{name}}");
}

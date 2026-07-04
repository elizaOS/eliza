/**
 * Char-length token estimate (`length / 4`) used for telemetry only — not a real
 * tokenizer; do not rely on it for context-window management.
 */
export async function countTokens(text: string): Promise<number> {
  return Math.ceil(text.length / 4);
}

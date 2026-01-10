/**
 * Helper function to count tokens for a given text (estimation)
 */
export async function countTokens(text: string): Promise<number> {
  // Rough estimation: ~1 token per 4 characters
  return Math.ceil(text.length / 4);
}

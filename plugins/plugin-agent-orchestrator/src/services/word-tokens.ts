/**
 * Script-agnostic word split for similarity checks: NFKC + lowercase, then
 * split on anything that is not a letter, combining mark, or digit. ASCII
 * input tokenizes exactly as the old `[^a-z0-9]+` split did. Scripts written
 * without spaces (Han, kana) come out as whole-phrase tokens, which only makes
 * matches rarer, never looser.
 */
export function wordTokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

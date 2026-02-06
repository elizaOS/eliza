/**
 * Similarity and matching utilities for entity resolution.
 *
 * These are intentionally lightweight – no external NLP dependencies.
 * The heavy lifting is done by the LLM; these provide fast pre-filters
 * for candidate generation in the small-world neighborhood scan.
 */

/**
 * Normalized Levenshtein distance between two strings.
 *
 * @returns A similarity score 0-1 where 1 means identical.
 */
export function nameSimilarity(a: string, b: string): number {
  const la = a.toLowerCase().trim();
  const lb = b.toLowerCase().trim();

  if (la === lb) return 1;
  if (la.length === 0 || lb.length === 0) return 0;

  const distance = levenshtein(la, lb);
  const maxLen = Math.max(la.length, lb.length);
  return 1 - distance / maxLen;
}

/**
 * Classic Levenshtein edit distance (Wagner-Fischer algorithm).
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use a single-row optimization for memory efficiency
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }

  return prev[n];
}

/**
 * Check whether two handles correlate across platforms.
 *
 * Strips common prefixes (@), normalizes case, and compares the
 * underlying username. Also checks for common patterns like
 * "dave_codes" matching "davecodes" matching "dave-codes".
 *
 * @returns Similarity score 0-1.
 */
export function handleCorrelation(handleA: string, handleB: string): number {
  const normA = normalizeHandle(handleA);
  const normB = normalizeHandle(handleB);

  if (normA === normB) return 1.0;

  // Check if one contains the other (e.g. "davecodes" in "dave_codes_eth")
  if (normA.includes(normB) || normB.includes(normA)) {
    const ratio = Math.min(normA.length, normB.length) / Math.max(normA.length, normB.length);
    return 0.6 + ratio * 0.3; // 0.6-0.9 range
  }

  // Fall back to Levenshtein
  return nameSimilarity(normA, normB);
}

/**
 * Normalize a handle by stripping @, removing separators, lowering case.
 */
export function normalizeHandle(handle: string): string {
  return handle
    .replace(/^@/, '')
    .replace(/[_\-. ]+/g, '')
    .replace(/#\d+$/, '') // Remove Discord discriminator
    .toLowerCase()
    .trim();
}

/**
 * Jaccard similarity between two sets.
 *
 * Used for comparing shared connections, shared rooms, shared topics.
 *
 * @returns Score 0-1 where 1 means identical sets.
 */
export function jaccardSimilarity<T>(setA: Set<T>, setB: Set<T>): number {
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check if two names could be nicknames / variations of each other.
 *
 * Handles common patterns:
 *  - "Dave" / "David"
 *  - "TechGuru" / "Tech Guru"
 *  - First name matching when one side has full name
 *
 * @returns Similarity score 0-1.
 */
export function nameVariationMatch(nameA: string, nameB: string): number {
  const a = nameA.trim();
  const b = nameB.trim();

  if (a.toLowerCase() === b.toLowerCase()) return 1.0;

  // Split into tokens BEFORE lowercasing (camelCase detection needs case info)
  const tokensA = splitIntoTokens(a);
  const tokensB = splitIntoTokens(b);

  // Check if any token from A matches any token from B
  let matchingTokens = 0;
  for (const ta of tokensA) {
    for (const tb of tokensB) {
      if (ta === tb) {
        matchingTokens++;
      } else if (ta.length >= 3 && tb.length >= 3) {
        // Check prefix match (e.g. "Dave" matches "David")
        const prefixLen = Math.min(3, ta.length, tb.length);
        if (ta.substring(0, prefixLen) === tb.substring(0, prefixLen)) {
          matchingTokens += 0.5;
        }
      }
    }
  }

  const maxTokens = Math.max(tokensA.length, tokensB.length);
  if (maxTokens === 0) return 0;

  return Math.min(1, matchingTokens / maxTokens);
}

/**
 * Split a name into tokens, handling separators and camelCase/PascalCase.
 * "TechGuru" -> ["tech", "guru"]
 * "dave_codes" -> ["dave", "codes"]
 * "Tech Guru" -> ["tech", "guru"]
 */
function splitIntoTokens(name: string): string[] {
  // First split on explicit separators
  const parts = name.split(/[\s_\-]+/).filter(Boolean);

  // Then split camelCase/PascalCase within each part
  const tokens: string[] = [];
  for (const part of parts) {
    // Insert a space before uppercase letters that follow lowercase letters
    const split = part.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/);
    tokens.push(...split.filter(Boolean));
  }

  return tokens;
}

/**
 * Extract the "base" username from a handle, stripping common suffixes
 * like platform markers (_dev, _eth, _nft) and numbers.
 */
export function extractBaseUsername(handle: string): string {
  return normalizeHandle(handle)
    .replace(/(dev|eth|nft|web3|crypto|official|real|the)$/i, '')
    .replace(/\d+$/, '')
    .trim();
}

/**
 * Quick check: could these two strings plausibly refer to the same
 * entity? Used as a fast pre-filter before more expensive analysis.
 *
 * @returns true if there's enough signal to warrant deeper comparison.
 */
export function couldBeSameEntity(nameA: string, nameB: string): boolean {
  // Exact match after normalization
  if (normalizeHandle(nameA) === normalizeHandle(nameB)) return true;

  // High name similarity
  if (nameSimilarity(nameA, nameB) > 0.7) return true;

  // Base username match
  if (
    extractBaseUsername(nameA).length >= 3 &&
    extractBaseUsername(nameA) === extractBaseUsername(nameB)
  ) {
    return true;
  }

  // Token overlap
  if (nameVariationMatch(nameA, nameB) > 0.5) return true;

  return false;
}

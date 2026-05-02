import type { SecretId } from "./types.js";

const ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*){2,}$/;

export class InvalidSecretIdError extends Error {
  constructor(id: string) {
    super(
      `Invalid secret id: ${JSON.stringify(id)}. Expected lowercase \`domain.subject.field\` (e.g. "llm.openrouter.apiKey").`,
    );
    this.name = "InvalidSecretIdError";
  }
}

export function assertSecretId(id: string): asserts id is SecretId {
  if (!ID_PATTERN.test(id)) throw new InvalidSecretIdError(id);
}

export function isSecretId(id: unknown): id is SecretId {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/**
 * Match `id` against a glob `pattern`.
 *
 * - Exact: `llm.openrouter.apiKey` matches only itself.
 * - Suffix wildcard: `llm.openrouter.*` matches `llm.openrouter.<anything>`.
 * - Single-segment wildcard: `llm.*.apiKey` matches one segment in that slot.
 * - Universal: `*` matches everything (reserved for first-party migration).
 *
 * Patterns must otherwise share the same lowercase shape as ids; we don't
 * accept regex.
 */
export function matchesPattern(pattern: string, id: SecretId): boolean {
  if (pattern === "*") return true;
  if (pattern === id) return true;

  const patternSegments = pattern.split(".");
  const idSegments = id.split(".");

  // `prefix.*` covers any depth at or beyond `prefix`.
  if (
    patternSegments[patternSegments.length - 1] === "*" &&
    patternSegments.length - 1 <= idSegments.length
  ) {
    for (let i = 0; i < patternSegments.length - 1; i += 1) {
      const p = patternSegments[i];
      const s = idSegments[i];
      if (p !== s && p !== "*") return false;
    }
    return true;
  }

  if (patternSegments.length !== idSegments.length) return false;
  for (let i = 0; i < patternSegments.length; i += 1) {
    const p = patternSegments[i];
    const s = idSegments[i];
    if (p !== s && p !== "*") return false;
  }
  return true;
}

/**
 * Returns the most specific matching pattern from `patterns`, or `null`.
 * Specificity: literal segments outrank wildcards left-to-right; longer
 * patterns outrank shorter ones with the same prefix; `*` is the weakest.
 */
export function selectMostSpecific(
  patterns: readonly string[],
  id: SecretId,
): string | null {
  let best: { pattern: string; score: number } | null = null;
  for (const pattern of patterns) {
    if (!matchesPattern(pattern, id)) continue;
    const score = scoreSpecificity(pattern);
    if (!best || score > best.score) best = { pattern, score };
  }
  return best?.pattern ?? null;
}

function scoreSpecificity(pattern: string): number {
  if (pattern === "*") return 0;
  let score = 0;
  for (const segment of pattern.split(".")) {
    score += segment === "*" ? 1 : 100;
  }
  return score;
}

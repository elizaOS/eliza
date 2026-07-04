/**
 * Secret-pattern scrub for imported conversation text.
 *
 * Conversation history routinely contains pasted API keys, tokens, and
 * credentials. `runtime.createMemory` only redacts *configured* secrets, not
 * arbitrary pasted ones, so the importer must run pattern-based redaction
 * itself before anything is stored.
 *
 * Patterns ported from ocplatform's migration SDK
 * (`src/plugin-sdk/migration.ts` → `SECRET_VALUE_PATTERNS`), extended with a
 * few high-signal cloud-credential shapes (AWS access key ids, PEM private-key
 * blocks) that show up in pasted transcripts.
 *
 * See conversation-importer-scope.md §2.1 (secret hygiene) and §4.5.
 */

export const REDACTED_PLACEHOLDER = "[redacted]";

/**
 * Ordered secret value patterns. Each is applied globally to the input string.
 * Order matters only for overlapping matches; these are disjoint enough that
 * order is not significant, but PEM blocks are matched first so their inner
 * base64 is not partially redacted by narrower rules.
 */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // PEM private key blocks (multi-line). Matched first, dot-matches-newline.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/gu,
  // HTTP Bearer tokens.
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gu,
  // OpenAI-style keys (sk-, sk-proj-, etc.).
  /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
  // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_).
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/gu,
  // Slack tokens (xoxb-/xoxa-/xoxp-/xoxr-/xoxs-).
  /\bxox[abprs]-[A-Za-z0-9-]{8,}\b/gu,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{12,}\b/gu,
  // AWS access key ids (AKIA/ASIA + 16 uppercase-alnum).
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
];

/**
 * Replace every recognized secret pattern in `input` with
 * {@link REDACTED_PLACEHOLDER}. Pure function; returns the input unchanged when
 * it contains no matches. Empty / non-string-safe inputs return `""`-safe.
 */
export function redactText(input: string): string {
  if (!input) {
    return input;
  }
  let next = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    // Reset lastIndex defensively: these are module-level global regexes and a
    // prior partial exec elsewhere could leave lastIndex non-zero. `replace`
    // resets it, but being explicit avoids surprises if callers reuse patterns.
    pattern.lastIndex = 0;
    next = next.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return next;
}

/** True when `input` contains at least one recognized secret pattern. */
export function containsSecret(input: string): boolean {
  if (!input) {
    return false;
  }
  return SECRET_VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}

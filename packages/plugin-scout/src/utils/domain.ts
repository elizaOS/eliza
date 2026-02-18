/**
 * Domain extraction utilities.
 *
 * Max input length of 2000 chars prevents ReDoS on pathological strings.
 * The regex uses bounded quantifiers ({0,61}) which limits backtracking.
 */

const MAX_INPUT_LENGTH = 2000;

const DOMAIN_REGEX = /(?:https?:\/\/)?([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,})/;
const DOMAIN_REGEX_GLOBAL = /(?:https?:\/\/)?([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,})/g;

/**
 * Extract a single domain from text. Returns null if none found.
 */
export function extractDomain(text: string): string | null {
  if (text.length > MAX_INPUT_LENGTH) text = text.slice(0, MAX_INPUT_LENGTH);
  const match = text.match(DOMAIN_REGEX);
  return match ? match[1] : null;
}

/**
 * Extract all unique domains from text.
 */
export function extractDomains(text: string): string[] {
  if (text.length > MAX_INPUT_LENGTH) text = text.slice(0, MAX_INPUT_LENGTH);
  const matches = text.matchAll(DOMAIN_REGEX_GLOBAL);
  const domains = new Set<string>();
  for (const match of matches) {
    domains.add(match[1]);
  }
  return [...domains];
}
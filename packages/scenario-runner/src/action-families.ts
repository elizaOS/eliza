/**
 * Fuzzy action-name matching for scenario assertions. A scenario's expected
 * action name rarely matches the runtime's emitted name character-for-character
 * (casing, `ACTION_` prefixes, singular/plural, token order), so final checks
 * compare through `actionsAreScenarioEquivalent` / `actionMatchesScenarioExpectation`
 * instead of string equality. Matching is token-based: names are normalized to
 * lowercase alphanumerics and compared for equality, prefix, or suffix overlap.
 */
function normalizeActionName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^action[.:_-]?/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function actionTokenList(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .replace(/^action[.:_-]?/, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isTokenPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length === 0 || prefix.length > full.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] !== full[i]) {
      return false;
    }
  }
  return true;
}

function isTokenSuffix(suffix: string[], full: string[]): boolean {
  if (suffix.length === 0 || suffix.length > full.length) {
    return false;
  }
  const offset = full.length - suffix.length;
  for (let i = 0; i < suffix.length; i += 1) {
    if (suffix[i] !== full[offset + i]) {
      return false;
    }
  }
  return true;
}

export function actionsAreScenarioEquivalent(
  candidate: string | undefined,
  expected: string | undefined,
): boolean {
  if (!candidate || !expected) {
    return false;
  }
  const left = normalizeActionName(candidate);
  const right = normalizeActionName(expected);
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  if (left === right) {
    return true;
  }

  // Bounded equivalence on the underscore-delimited token sequence. Two cases
  // count as equivalent:
  //   1. Parent/sub-action family — one action's tokens are a leading prefix of
  //      the other's (CALENDAR_CREATE ↔ CALENDAR_CREATE_EVENT, SEND ↔ SEND_EMAIL).
  //   2. Provider-qualified candidate — a multi-token expectation is a
  //      contiguous suffix of the candidate (GOOGLE_CALENDAR_CREATE_EVENT ↔
  //      CALENDAR_CREATE_EVENT), so a provider prefix on the actual action still
  //      matches the expectation. Single-token suffixes are deliberately
  //      excluded; otherwise SEND_EMAIL would satisfy an EMAIL expectation.
  // This deliberately rejects the unbounded separator-stripped `includes`/token
  // -subset over-match where a strictly more generic candidate (LIFE, MESSAGE,
  // INBOX) was credited for a more specific expectation (LIFEOPS, READ_MESSAGES,
  // INBOX_TRIAGE) on a non-token boundary.
  const leftTokens = actionTokenList(candidate);
  const rightTokens = actionTokenList(expected);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return false;
  }
  return (
    isTokenPrefix(rightTokens, leftTokens) ||
    isTokenPrefix(leftTokens, rightTokens) ||
    (rightTokens.length >= 2 && isTokenSuffix(rightTokens, leftTokens))
  );
}

export function actionMatchesScenarioExpectation(
  candidate: string | undefined,
  expected: readonly string[],
): boolean {
  if (expected.length === 0) {
    return true;
  }
  return expected.some((item) => actionsAreScenarioEquivalent(candidate, item));
}

function normalizeActionName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^action[.:_-]?/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function actionTokens(value: string): Set<string> {
  return new Set(
    value
      .trim()
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
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
  if (left === right || left.includes(right) || right.includes(left)) {
    return true;
  }

  const leftTokens = actionTokens(candidate);
  const rightTokens = actionTokens(expected);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return false;
  }
  let overlap = 0;
  for (const token of rightTokens) {
    if (leftTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap === rightTokens.size || overlap === leftTokens.size;
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

export function normalizeScenarioActionName(
  actionName: string | null | undefined,
): string | null {
  const normalized = String(actionName ?? "")
    .trim()
    .toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

export function actionsAreScenarioEquivalent(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeScenarioActionName(left);
  const normalizedRight = normalizeScenarioActionName(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return normalizedLeft === normalizedRight;
}

export function actionMatchesScenarioExpectation(
  candidate: string | null | undefined,
  accepted: readonly string[],
): boolean {
  return accepted.some((expected) =>
    actionsAreScenarioEquivalent(candidate, expected),
  );
}

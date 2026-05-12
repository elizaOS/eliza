type AgentsListSnapshot = unknown[] | undefined;

function agentsListEntriesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function shouldRestoreAgentsListAfterAppLaunch(
  before: AgentsListSnapshot,
  after: unknown,
): boolean {
  if (!Array.isArray(after)) {
    return false;
  }
  if (!before) {
    return after.length > 0;
  }
  if (after.length < before.length) {
    return true;
  }
  return before.some(
    (entry, index) => !agentsListEntriesEqual(entry, after[index]),
  );
}

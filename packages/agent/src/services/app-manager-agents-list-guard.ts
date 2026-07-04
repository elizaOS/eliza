/**
 * Pure predicate deciding whether the persisted agents list should be restored
 * after launching an app mutated it: restore when an app populates a
 * previously-empty list or replaces the user's existing first agent, but not
 * when it merely appends a supplemental agent.
 */
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

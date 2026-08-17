/**
 * #18092 release lock model.
 *
 * GitHub's concurrency contract (docs.github.com control-workflow-concurrency):
 * at most one running and one pending member per group. A new pending member
 * evicts the previous waiter; `cancel-in-progress: false` preserves only the
 * active member.
 *
 * Admission groups must be unique per non-PR run so two dispatches of the
 * same SHA both create jobs. Mutation is one holder for the whole
 * migrate/API/Pages/verify (or publish/CDN) lifecycle. Callers must account
 * for GitHub replacing an existing pending release when a third one arrives.
 */

export function admissionGroup({ eventName, prNumber, runId }) {
  if (eventName === "pull_request") {
    return {
      group: `pr-${prNumber}`,
      cancelInProgress: true,
    };
  }
  return {
    group: `run-${runId}`,
    cancelInProgress: false,
  };
}

export function releaseGroup(environment) {
  return {
    group: `release-${environment}`,
    cancelInProgress: false,
  };
}

export function createConcurrencyGroup({ cancelInProgress = false } = {}) {
  return {
    active: null,
    pending: [],
    cancelInProgress,
    cancelled: new Set(),
  };
}

export function requestConcurrency(group, id) {
  if (!group.active) {
    group.active = id;
    return "active";
  }
  if (group.cancelInProgress) {
    group.cancelled.add(group.active);
    for (const waiter of group.pending) group.cancelled.add(waiter);
    group.active = id;
    group.pending = [];
    return "active";
  }
  const current = group.pending[0];
  if (current && current !== id) group.cancelled.add(current);
  group.pending = [id];
  return "pending";
}

export function completeConcurrency(group, id) {
  if (group.active !== id) return;
  group.active = group.pending.shift() ?? null;
}

/**
 * A release is one lock holder from first mutate through last verify.
 * Modeling migrate/api/pages as separate holders is the interleaving bug.
 */
export function overlappingMutations(activeHolders) {
  const mutating = activeHolders.filter((holder) => holder.phase !== "admit");
  return mutating.length > 1;
}

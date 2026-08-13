/**
 * #18092 release lock model.
 *
 * GitHub concurrency is not a FIFO queue. A group has at most one active
 * member and one pending member. cancel-in-progress:false protects the
 * active member and evicts a previous pending member.
 *
 * Admission groups must be unique per non-PR run so two dispatches of the
 * same SHA both create jobs. Mutation must be one holder for the whole
 * migrate/API/Pages/verify (or publish/CDN) lifecycle.
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

export function createConcurrencyGroup({ cancelInProgress }) {
  return {
    active: null,
    pending: null,
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
    if (group.pending) group.cancelled.add(group.pending);
    group.active = id;
    group.pending = null;
    return "active";
  }
  if (group.pending && group.pending !== id) {
    group.cancelled.add(group.pending);
  }
  group.pending = id;
  return "pending";
}

export function completeConcurrency(group, id) {
  if (group.active !== id) return;
  group.active = group.pending;
  group.pending = null;
}

/**
 * A release is one lock holder from first mutate through last verify.
 * Modeling migrate/api/pages as separate holders is the interleaving bug.
 */
export function overlappingMutations(activeHolders) {
  const mutating = activeHolders.filter((holder) => holder.phase !== "admit");
  return mutating.length > 1;
}

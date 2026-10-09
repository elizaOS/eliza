/**
 * #18092 release lock model.
 *
 * GitHub's concurrency contract (docs.github.com control-workflow-concurrency):
 * at most one running member per group. Default `queue: single` keeps at most
 * one pending member and evicts the previous waiter. `queue: max` keeps up
 * to 100 pending members and processes them FIFO by wait-start (not dispatch);
 * ordering is not guaranteed. `queue: max` cannot combine with
 * `cancel-in-progress: true`.
 *
 * Admission groups must be unique per non-PR run so two dispatches of the
 * same SHA both create jobs. Mutation is one holder for the whole
 * migrate/API/Pages/verify (or publish/CDN) lifecycle, with `queue: max` so
 * a third approved release waits instead of cancelling the second.
 */

const MAX_PENDING = 100;

export function admissionGroup({ eventName, prNumber, runId }) {
  if (eventName === "pull_request") {
    return {
      group: `pr-${prNumber}`,
      cancelInProgress: true,
      queue: "single",
    };
  }
  return {
    group: `run-${runId}`,
    cancelInProgress: false,
    queue: "single",
  };
}

export function releaseGroup(environment) {
  return {
    group: `release-${environment}`,
    cancelInProgress: false,
    queue: "max",
  };
}

export function createConcurrencyGroup({
  cancelInProgress = false,
  queue = "single",
} = {}) {
  if (cancelInProgress && queue === "max") {
    throw new Error(
      "The combination of queue: max and cancel-in-progress: true is not allowed",
    );
  }
  return {
    active: null,
    pending: [],
    cancelInProgress,
    queue,
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
  if (group.queue === "max") {
    if (group.pending.includes(id)) return "pending";
    if (group.pending.length >= MAX_PENDING) {
      group.cancelled.add(id);
      return "cancelled";
    }
    group.pending.push(id);
    return "pending";
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

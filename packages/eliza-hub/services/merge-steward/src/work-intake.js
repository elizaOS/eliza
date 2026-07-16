import { QUEUE_STATES } from "./policy.js";
import { workItemId } from "./store.js";

const WORK_INTAKE_SCHEMA = "https://eliza.hub/schemas/work-intake-plan.v1";

const TERMINAL_QUEUE_STATES = new Set([
  QUEUE_STATES.MERGED,
  QUEUE_STATES.CLOSED,
  QUEUE_STATES.FAILED,
  QUEUE_STATES.CANCELLED,
]);

export function buildWorkIntakePlan({
  queueItems = [],
  workItems = [],
  repo,
  ownerAgentId,
  now = new Date().toISOString(),
  maxActions = 100,
} = {}) {
  const filters = {
    repo: stringOrNull(repo),
    ownerAgentId: stringOrNull(ownerAgentId),
  };
  const existingByPr = indexWorkItems(workItems);
  const actionLimit = positiveInteger(maxActions, 100);
  const sourceQueueItems = arrayValue(queueItems).filter((item) =>
    matchesFilters(item, filters),
  );
  const actions = [];
  const skipped = [];

  for (const item of sourceQueueItems) {
    const target = targetWorkItemFromQueueItem(item, { now });
    if (!target) {
      skipped.push({
        id: item.id ?? null,
        repo: item.repo ?? null,
        pullRequestId: item.pullRequestId ?? null,
        reason: "missing_repo_or_pull_request",
      });
      continue;
    }

    const existing = existingByPr.get(workPrKey(target)) ?? null;
    actions.push(workIntakeAction({ item, target, existing, now }));
  }

  const limitedActions = actions.slice(0, actionLimit);
  const truncated = actions.length > limitedActions.length;
  const counts = countActions(limitedActions, skipped);

  return {
    schema: WORK_INTAKE_SCHEMA,
    computedAt: now,
    filters,
    summary: {
      queueItems: sourceQueueItems.length,
      existingWorkItems: arrayValue(workItems).filter((item) =>
        matchesFilters(item, filters),
      ).length,
      actions: limitedActions.length,
      creates: counts.create_work_item,
      transitions: counts.transition_work_item,
      updates: counts.update_work_item,
      unchanged: counts.noop,
      skipped: skipped.length,
      truncated,
    },
    actions: limitedActions,
    skipped,
  };
}

function workIntakeAction({ item, target, existing, now }) {
  const changes = existing ? workItemChanges(existing, target) : [];
  const transition =
    existing && existing.state !== target.state
      ? {
          from: existing.state,
          to: target.state,
          reason: `queue_state:${item.queueState ?? "unknown"}`,
        }
      : null;
  const targetWorkItem = transition
    ? withAutomationTransition(target, existing, { item, transition, now })
    : target;
  const type = !existing
    ? "create_work_item"
    : transition
      ? "transition_work_item"
      : changes.length > 0
        ? "update_work_item"
        : "noop";

  return {
    id: `work-intake:${target.id}`,
    type,
    reason: actionReason(type, item, transition),
    queueItem: queueItemSummary(item),
    existingWorkItemId: existing?.id ?? null,
    targetWorkItem,
    changes,
    transition,
  };
}

function targetWorkItemFromQueueItem(item = {}, { now } = {}) {
  const repo = stringOrNull(item.repo);
  const pullRequestId = integerOrNull(
    item.pullRequestId ?? item.pr ?? item.number,
  );
  if (!repo || pullRequestId == null) return null;

  const queueState =
    stringOrNull(item.queueState ?? item.state) ?? QUEUE_STATES.OBSERVED;
  const targetBranch = stringOrNull(item.targetBranch ?? item.baseBranch);
  const sourceBranch = stringOrNull(item.sourceBranch ?? item.headBranch);
  const title = stringOrNull(item.title) ?? `${repo} PR #${pullRequestId}`;

  const target = {
    repo,
    kind: "pull_request",
    pullRequestId,
    state: workStateFromQueueState(queueState),
    title,
    summary: queueItemSummaryText(item, queueState),
    priority: numberValue(item.priority),
    ownerAgentId: stringOrNull(item.ownerAgentId ?? item.agentId),
    targetBranch,
    paths: uniqueStrings(item.changedFiles ?? item.paths ?? item.files),
    packages: uniqueStrings(item.affectedPackages ?? item.packages),
    labels: uniqueStrings(item.labels),
    metadata: {
      automation: {
        source: "work_intake",
        queueItemId: stringOrNull(item.id),
        queueState,
        lastPlannedAt: now,
      },
      queue: {
        id: stringOrNull(item.id),
        state: queueState,
        sourceBranch,
        targetBranch,
        headSha: stringOrNull(item.headSha),
        authorKind: stringOrNull(item.authorKind),
        riskLevel: stringOrNull(item.riskLevel),
      },
    },
    updatedAt: now,
  };
  target.id = workItemId(target);
  return target;
}

function withAutomationTransition(target, existing, { item, transition, now }) {
  return {
    ...target,
    metadata: {
      ...(existing.metadata ?? {}),
      ...(target.metadata ?? {}),
      transitions: [
        ...arrayValue(existing.metadata?.transitions),
        {
          from: transition.from,
          to: transition.to,
          actorId: "work-intake",
          reason: transition.reason,
          queueItemId: item.id ?? null,
          at: now,
        },
      ],
    },
    createdAt: existing.createdAt,
  };
}

function workStateFromQueueState(queueState) {
  const state = String(queueState ?? "").toLowerCase();
  if (state === QUEUE_STATES.MERGED) return "done";
  if (state === QUEUE_STATES.CLOSED || state === QUEUE_STATES.CANCELLED)
    return "cancelled";
  if (
    state === QUEUE_STATES.BLOCKED_CONFLICT ||
    state === QUEUE_STATES.BLOCKED_POLICY ||
    state === QUEUE_STATES.BLOCKED_STALE ||
    state === QUEUE_STATES.FAILED ||
    state === QUEUE_STATES.INTEGRATION_FAILED ||
    state === QUEUE_STATES.QUARANTINED
  )
    return "blocked";
  if (state === QUEUE_STATES.WAITING_FOR_REVIEW || state.includes("approval"))
    return "needs_human_review";
  if (
    state === QUEUE_STATES.RUNNING ||
    state === QUEUE_STATES.BUILDING_INTEGRATION
  )
    return "merge_queue";
  if (state === QUEUE_STATES.WAITING_FOR_CHECKS) return "in_progress";
  if (
    state === QUEUE_STATES.READY ||
    state === QUEUE_STATES.QUEUED ||
    state === QUEUE_STATES.TRIAGED
  )
    return "ready";
  return "backlog";
}

function workItemChanges(existing, target) {
  return [
    change("state", existing.state, target.state),
    change("title", existing.title, target.title),
    change("summary", existing.summary, target.summary),
    change(
      "priority",
      numberValue(existing.priority),
      numberValue(target.priority),
    ),
    change(
      "ownerAgentId",
      existing.ownerAgentId ?? null,
      target.ownerAgentId ?? null,
    ),
    change(
      "targetBranch",
      existing.targetBranch ?? null,
      target.targetBranch ?? null,
    ),
    change(
      "paths",
      uniqueStrings(existing.paths),
      uniqueStrings(target.paths),
      sameStringArray,
    ),
    change(
      "packages",
      uniqueStrings(existing.packages),
      uniqueStrings(target.packages),
      sameStringArray,
    ),
    change(
      "labels",
      uniqueStrings(existing.labels),
      uniqueStrings(target.labels),
      sameStringArray,
    ),
  ].filter(Boolean);
}

function actionReason(type, item, transition) {
  if (type === "create_work_item") return "queue_item_has_no_work_item";
  if (type === "transition_work_item")
    return `queue_state_maps_to_${transition.to}`;
  if (type === "update_work_item") return "queue_metadata_changed";
  if (TERMINAL_QUEUE_STATES.has(item.queueState))
    return "terminal_queue_item_already_synced";
  return "work_item_current";
}

function queueItemSummary(item) {
  return {
    id: item.id ?? null,
    repo: item.repo ?? null,
    pullRequestId: item.pullRequestId ?? null,
    title: item.title ?? null,
    queueState: item.queueState ?? null,
    ownerAgentId: item.ownerAgentId ?? null,
    targetBranch: item.targetBranch ?? null,
    sourceBranch: item.sourceBranch ?? null,
  };
}

function queueItemSummaryText(item, queueState) {
  const pr = item.pullRequestId == null ? "PR" : `PR #${item.pullRequestId}`;
  const branch = item.targetBranch ? ` targeting ${item.targetBranch}` : "";
  return `${pr} observed in queue state ${queueState}${branch}.`;
}

function indexWorkItems(workItems) {
  const index = new Map();
  for (const item of arrayValue(workItems)) {
    const key = workPrKey(item);
    if (key) index.set(key, item);
  }
  return index;
}

function workPrKey(item = {}) {
  const repo = stringOrNull(item.repo);
  const pullRequestId = integerOrNull(
    item.pullRequestId ?? item.pull_request_id,
  );
  return repo && pullRequestId != null ? `${repo}#${pullRequestId}` : null;
}

function matchesFilters(item = {}, filters = {}) {
  if (filters.repo && item.repo !== filters.repo) return false;
  if (filters.ownerAgentId && item.ownerAgentId !== filters.ownerAgentId)
    return false;
  return true;
}

function countActions(actions, skipped) {
  const counts = {
    create_work_item: 0,
    transition_work_item: 0,
    update_work_item: 0,
    noop: 0,
    skipped: skipped.length,
  };
  for (const action of actions)
    counts[action.type] = (counts[action.type] ?? 0) + 1;
  return counts;
}

function change(field, from, to, equals = Object.is) {
  return equals(from, to) ? null : { field, from, to };
}

function sameStringArray(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function uniqueStrings(value) {
  return [
    ...new Set(
      arrayValue(value)
        .map((item) => String(item).trim())
        .filter(Boolean),
    ),
  ].sort();
}

function arrayValue(value) {
  if (value instanceof Set) return [...value];
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function integerOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

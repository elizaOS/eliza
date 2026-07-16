export const QUEUE_ITEM_ACTION_PLAN_VERSION = 1;
export const QUEUE_ITEM_ACTION_PLAN_SCHEMA =
  "https://eliza.hub/schemas/queue-item-action-plan.v1";

export function buildQueueItemActionPlan({
  queueItem,
  queueSummary = {},
  mergeTrain = {},
  workflow = {},
  runState = null,
  ownerAgentId,
  now = new Date().toISOString(),
} = {}) {
  const item = objectValue(queueItem);
  const itemId = queueItemIdentity(item);
  if (!itemId)
    throw new TypeError("Queue item action plan requires a queue item id");

  const summaryItem = findQueueSummaryItem(queueSummary, item);
  const workflowCard = findWorkflowCard(workflow, itemId);
  const laneKey = summaryItem?.laneKey ?? queueLaneKey(item);
  const lane = findLane(mergeTrain, laneKey);
  const selectedTrain = objectValue(mergeTrain.selectedTrain);
  const selectedItemIds = arrayValue(selectedTrain.itemIds);
  const inSelectedTrain = selectedItemIds.includes(itemId);
  const nextSteps = rankedNextSteps({
    item,
    itemId,
    summaryItem,
    workflowCard,
    runState,
    selectedTrain,
    inSelectedTrain,
    lane,
  });

  return {
    version: QUEUE_ITEM_ACTION_PLAN_VERSION,
    schema: QUEUE_ITEM_ACTION_PLAN_SCHEMA,
    computedAt: now,
    readOnly: true,
    status: planStatus({
      summaryItem,
      workflowCard,
      runState,
      inSelectedTrain,
      lane,
      nextSteps,
    }),
    item: itemSummary(item, itemId, ownerAgentId),
    queue: queueSummaryFor({ queueSummary, summaryItem }),
    runState: objectOrNull(runState),
    workflow: workflowSummaryFor(workflowCard),
    mergeTrain: mergeTrainSummaryFor({
      mergeTrain,
      selectedTrain,
      inSelectedTrain,
      lane,
      itemId,
    }),
    nextSteps,
    links: linksFor({
      item,
      itemId,
      ownerAgentId: ownerAgentId ?? item.ownerAgentId,
    }),
    snapshots: {
      queueItem: item,
      queueSummaryItem: summaryItem ?? {},
      workflowCard: workflowCard ?? {},
    },
  };
}

function planStatus({
  summaryItem,
  workflowCard,
  runState,
  inSelectedTrain,
  lane,
  nextSteps,
}) {
  if (nextSteps.some((step) => step.blocking === true))
    return "needs_attention";
  if (runState?.state === "running") return "running";
  if (summaryItem?.planned === true || inSelectedTrain)
    return "ready_for_train";
  if (summaryItem?.scheduled === true) return "queued";
  if (lane?.state === "busy") return "waiting";
  if (workflowCard?.status === "ready") return "ready";
  return "watching";
}

function itemSummary(item, itemId, ownerAgentId) {
  return {
    id: itemId,
    repo: stringOrNull(item.repo),
    pullRequestId: item.pullRequestId ?? null,
    sourceBranch: stringOrNull(item.sourceBranch),
    targetBranch: stringOrNull(item.targetBranch),
    ownerAgentId: stringOrNull(ownerAgentId ?? item.ownerAgentId),
    authorKind: stringOrNull(item.authorKind),
    queueState: stringOrNull(item.queueState),
    priority: numberOrZero(item.priority),
    headSha: stringOrNull(item.headSha),
  };
}

function queueSummaryFor({ queueSummary = {}, summaryItem = null }) {
  const decision = objectValue(summaryItem?.decision);
  return {
    health: queueSummary.diagnostics?.health ?? null,
    nextAction: queueSummary.diagnostics?.nextAction ?? null,
    laneKey: summaryItem?.laneKey ?? null,
    queuePosition: summaryItem?.queuePosition ?? null,
    scheduled: summaryItem?.scheduled === true,
    planned: summaryItem?.planned === true,
    batchEligibility: summaryItem?.batchEligibility ?? null,
    stack: summaryItem?.stack ?? null,
    decision: Object.keys(decision).length > 0 ? decision : null,
  };
}

function workflowSummaryFor(card = null) {
  if (!card) {
    return {
      cardId: null,
      status: null,
      nextActions: [],
      approvals: [],
      humanRequests: [],
      claims: [],
    };
  }
  return {
    cardId: card.id ?? null,
    status: card.status ?? null,
    nextActions: unique(arrayValue(card.nextActions)),
    approvals: arrayValue(card.approvals),
    humanRequests: arrayValue(card.humanRequests),
    claims: arrayValue(card.claims),
    updatedAt: card.updatedAt ?? null,
  };
}

function mergeTrainSummaryFor({
  mergeTrain = {},
  selectedTrain = {},
  inSelectedTrain,
  lane = null,
  itemId,
}) {
  return {
    status: mergeTrain.status ?? null,
    inSelectedTrain,
    selectedTrainId: selectedTrain.id ?? null,
    selectedTrainNextAction: selectedTrain.nextAction ?? null,
    selectedTrainItemIds: arrayValue(selectedTrain.itemIds),
    selectedTrainBlockers: arrayValue(selectedTrain.blockers),
    laneKey: lane?.key ?? null,
    laneState: lane?.state ?? null,
    laneNextAction: lane?.nextAction ?? null,
    lanePlannedItemIds: arrayValue(lane?.plannedItemIds),
    laneBlockedItemIds: arrayValue(lane?.blockedItems)
      .map((item) => item.id)
      .filter(Boolean),
    laneRunningItemIds: arrayValue(lane?.runningItemIds),
    itemSelectedIndex: arrayValue(selectedTrain.itemIds).indexOf(itemId),
  };
}

function rankedNextSteps({
  item,
  itemId,
  summaryItem,
  workflowCard,
  runState,
  selectedTrain,
  inSelectedTrain,
  lane,
}) {
  const steps = [];
  const workflowActions = new Set(arrayValue(workflowCard?.nextActions));
  if (workflowActions.has("decide_approval")) {
    steps.push(
      step(
        "decide_approval",
        100,
        true,
        "workflow",
        "A human approval is open for this PR.",
        "GET",
        agentInboxHref(item),
      ),
    );
  }
  if (workflowActions.has("answer_human_request")) {
    steps.push(
      step(
        "answer_human_request",
        98,
        true,
        "workflow",
        "A human request is waiting on this PR.",
        "GET",
        agentInboxHref(item),
      ),
    );
  }
  if (workflowActions.has("recover_or_release_stale_work")) {
    steps.push(
      step(
        "recover_or_release_stale_work",
        94,
        true,
        "workflow",
        "This PR has stale claim or run evidence.",
        "GET",
        runStateHref(itemId),
      ),
    );
  }

  const decision = objectValue(summaryItem?.decision);
  if (decision.allowed === false) {
    steps.push({
      ...step(
        "resolve_queue_policy",
        92,
        true,
        "queue_policy",
        decision.state ?? "Queue policy is blocking this PR.",
        "GET",
        queueItemHref(itemId),
      ),
      blockers: arrayValue(decision.blockers),
      requiredActions: arrayValue(decision.requiredActions),
    });
  }

  if (summaryItem?.stack?.stackBlocked === true) {
    steps.push({
      ...step(
        "merge_stack_parents_first",
        88,
        true,
        "stack",
        "This PR is waiting on parent PRs in its stack.",
        "GET",
        mergeQueueHref(item),
      ),
      blockingDependencies: arrayValue(summaryItem.stack.blockingDependencies),
      requiredActions: arrayValue(summaryItem.stack.requiredActions),
    });
  }

  if (runState?.state === "failed" || runState?.unhealthy) {
    steps.push(
      step(
        "inspect_failed_or_unhealthy_run",
        86,
        true,
        "run_state",
        "Run state is failed or unhealthy.",
        "GET",
        runStateHref(itemId),
      ),
    );
  }
  if (runState?.state === "running") {
    steps.push(
      step(
        "watch_run",
        55,
        false,
        "run_state",
        "A run is active for this PR.",
        "GET",
        runStateHref(itemId),
      ),
    );
  }
  if (
    runState?.state === "waiting-event" &&
    item.queueState === "waiting_for_checks"
  ) {
    steps.push(
      step(
        "wait_for_required_checks",
        50,
        false,
        "run_state",
        "Required checks have not finished yet.",
        "GET",
        runStateHref(itemId),
      ),
    );
  }

  if (inSelectedTrain && selectedTrain.nextAction === "review_dry_run_train") {
    steps.push(
      step(
        "review_dry_run_train",
        78,
        false,
        "merge_train",
        "This PR is in the selected dry-run train.",
        "GET",
        mergeTrainHref(item),
      ),
    );
  } else if (
    inSelectedTrain &&
    selectedTrain.nextAction === "execute_queue_run_once"
  ) {
    steps.push(
      step(
        "execute_queue_run_once",
        76,
        false,
        "merge_train",
        "This PR is in the selected executable train.",
        "POST",
        "/api/queue/run-once",
      ),
    );
  } else if (inSelectedTrain && arrayValue(selectedTrain.blockers).length > 0) {
    steps.push({
      ...step(
        "resolve_selected_train_blockers",
        74,
        true,
        "merge_train",
        "The selected train has blockers.",
        "GET",
        mergeTrainHref(item),
      ),
      blockers: arrayValue(selectedTrain.blockers),
    });
  }

  if (lane?.nextAction === "wait_for_active_lane") {
    steps.push(
      step(
        "wait_for_active_lane",
        62,
        false,
        "merge_train",
        "This PR lane already has active merge work.",
        "GET",
        mergeTrainHref(item),
      ),
    );
  }
  if (
    summaryItem?.scheduled === true &&
    summaryItem?.planned !== true &&
    summaryItem?.batchEligibility?.selected === false
  ) {
    steps.push({
      ...step(
        "wait_for_batch_slot",
        48,
        false,
        "merge_queue",
        "This PR is ready but was not selected for the current batch.",
        "GET",
        mergeQueueHref(item),
      ),
      reason: summaryItem.batchEligibility.reason ?? null,
    });
  }
  if (summaryItem?.scheduled === true && summaryItem?.queuePosition != null) {
    steps.push(
      step(
        "monitor_queue_position",
        40,
        false,
        "merge_queue",
        `Queue position ${summaryItem.queuePosition}.`,
        "GET",
        mergeQueueHref(item),
      ),
    );
  }

  if (steps.length === 0) {
    steps.push(
      step(
        "inspect_queue_item",
        20,
        false,
        "queue_item",
        "No blocking action is currently required.",
        "GET",
        queueItemHref(itemId),
      ),
    );
  }

  return uniqueSteps(steps).sort(compareSteps).slice(0, 12);
}

function step(id, priority, blocking, source, reason, method, href) {
  return {
    id,
    priority,
    blocking,
    source,
    reason,
    method,
    href,
  };
}

function compareSteps(left, right) {
  return (
    Boolean(right.blocking) - Boolean(left.blocking) ||
    numberOrZero(right.priority) - numberOrZero(left.priority) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function uniqueSteps(steps) {
  const byKey = new Map();
  for (const item of steps) {
    const key = `${item.id}:${item.href ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

function linksFor({ item, itemId, ownerAgentId }) {
  return {
    self: `/api/queue/item/action-plan?id=${encodeURIComponent(itemId)}`,
    queueItem: queueItemHref(itemId),
    runState: runStateHref(itemId),
    mergeQueue: mergeQueueHref(item),
    mergeTrain: mergeTrainHref(item),
    ...(ownerAgentId
      ? {
          agentCockpit: `/api/agents/${encodeURIComponent(ownerAgentId)}/cockpit${repoQuery(item)}`,
          agentActionPlan: `/api/agents/${encodeURIComponent(ownerAgentId)}/action-plan`,
        }
      : {}),
  };
}

function findQueueSummaryItem(queueSummary = {}, item = {}) {
  const itemId = queueItemIdentity(item);
  return (
    arrayValue(queueSummary.items).find(
      (candidate) => candidate.id === itemId,
    ) ?? null
  );
}

function findWorkflowCard(workflow = {}, itemId) {
  return (
    arrayValue(workflow.cards).find((card) => card.id === `queue:${itemId}`) ??
    null
  );
}

function findLane(mergeTrain = {}, laneKey) {
  return (
    arrayValue(mergeTrain.lanes).find((lane) => lane.key === laneKey) ?? null
  );
}

function queueItemIdentity(item = {}) {
  if (item.id) return String(item.id);
  if (item.repo && item.pullRequestId != null)
    return `${item.repo}#${item.pullRequestId}`;
  return "";
}

function queueLaneKey(item = {}) {
  return `${item.repo ?? "unknown"}:${item.targetBranch ?? ""}`;
}

function queueItemHref(itemId) {
  return `/api/queue/item?id=${encodeURIComponent(itemId)}`;
}

function runStateHref(itemId) {
  return `/api/queue/item/run-state?id=${encodeURIComponent(itemId)}`;
}

function mergeQueueHref(item = {}) {
  return `/api/merge-queue${repoQuery(item)}`;
}

function mergeTrainHref(item = {}) {
  return `/api/merge-train${repoQuery(item)}`;
}

function agentInboxHref(item = {}) {
  const agentId = item.ownerAgentId;
  if (!agentId) return mergeQueueHref(item);
  return `/api/agents/${encodeURIComponent(agentId)}/inbox${repoQuery(item)}`;
}

function repoQuery(item = {}) {
  const params = new URLSearchParams();
  if (item.repo) params.set("repo", item.repo);
  if (item.targetBranch) params.set("targetBranch", item.targetBranch);
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function objectOrNull(value) {
  const normalized = objectValue(value);
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function unique(values = []) {
  return [
    ...new Set(
      values
        .filter((value) => value != null && value !== "")
        .map((value) => String(value)),
    ),
  ];
}

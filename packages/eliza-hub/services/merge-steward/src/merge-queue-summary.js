import {
  buildBatchEligibilityIndex,
  buildIntegrationPlan,
} from "./integration-plan.js";
import { evaluateMergePolicy, scheduleQueue } from "./policy.js";
import {
  applyStackDependencyEvidence,
  buildStackDependencyGraph,
} from "./stack-dependencies.js";

const TERMINAL_QUEUE_STATES = new Set([
  "closed",
  "merged",
  "failed",
  "cancelled",
]);

export function buildMergeQueueSummary({
  queueItems = [],
  policy,
  config = {},
  now = new Date().toISOString(),
  repo,
  targetBranch,
} = {}) {
  const filters = normalizeFilters({ repo, targetBranch });
  const scopedItems = applyStackDependencyEvidence(
    queueItems.filter((item) => matchesFilters(item, filters)),
  );
  const evaluatedItems = scopedItems.map((item) => {
    const decision = evaluateMergePolicy(item, policy);
    return {
      item,
      decision,
    };
  });
  const scheduled = scheduleQueue(scopedItems, policy);
  const plan = buildIntegrationPlan({ items: scopedItems, policy, config });
  const dependencies = buildStackDependencyGraph({ queueItems: scopedItems });
  const dependencyIndex = new Map(
    dependencies.items.map((item) => [item.id, item]),
  );
  const scheduledIds = new Set(scheduled.map(queueItemIdentity));
  const plannedIds = new Set(
    plan.plans.map((entry) => `${entry.repo}#${entry.pullRequestId}`),
  );
  const batchEligibility = buildBatchEligibilityIndex({ scheduled, config });
  const lanes = summarizeLanes({
    evaluatedItems,
    scheduled,
    plan,
    policy,
    config,
  });
  const items = evaluatedItems.map(({ item, decision }) =>
    itemSummary({
      item,
      decision,
      stack: dependencyIndex.get(itemIdentity(item)) ?? null,
      scheduledItem: scheduled.find(
        (candidate) => queueItemIdentity(candidate) === queueItemIdentity(item),
      ),
      scheduledIds,
      plannedIds,
      batchEligibility:
        batchEligibility.index.get(queueItemIdentity(item)) ?? null,
    }),
  );
  const counts = {
    items: scopedItems.length,
    lanes: lanes.length,
    scheduled: scheduled.length,
    planned: plan.plans.length,
    blocked: evaluatedItems.filter(
      ({ item, decision }) =>
        !decision.allowed && !TERMINAL_QUEUE_STATES.has(item.queueState),
    ).length,
    running: scopedItems.filter(
      (item) =>
        item.queueState === "running" ||
        item.queueState === "building_integration",
    ).length,
    terminal: scopedItems.filter((item) =>
      TERMINAL_QUEUE_STATES.has(item.queueState),
    ).length,
  };

  return {
    computedAt: now,
    filters,
    integration: {
      enabled: config.enabled === true,
      dryRun: config.dryRun !== false,
      executor: config.executor ?? "none",
      branchPrefix: config.branchPrefix ?? "eliza-queue",
      batching: config.allowBatching === true,
      maxBatchSize: config.maxBatchSize ?? null,
      allowEmptyRequiredChecks: config.allowEmptyRequiredChecks === true,
    },
    counts,
    selectedPlan: {
      enabled: plan.enabled,
      dryRun: plan.dryRun,
      strategy: plan.strategy,
      batch: plan.batch,
      queuedCount: plan.queuedCount,
      planCount: plan.planCount,
      plans: plan.plans,
      skippedItems: plan.skippedItems,
      reason: plan.reason,
    },
    dependencies: dependencyDiagnostics(dependencies),
    batchEligibility: {
      selectedItemIds: batchEligibility.selectedItemIds,
      skippedItems: batchEligibility.skippedItems,
    },
    diagnostics: buildQueueDiagnostics({
      counts,
      integration: config,
      lanes,
      items,
      plan,
      batchEligibility,
      dependencies,
    }),
    lanes,
    items,
  };
}

function buildQueueDiagnostics({
  counts,
  integration = {},
  lanes = [],
  items = [],
  plan = {},
  batchEligibility = {},
  dependencies = {},
}) {
  const blockedItems = items.filter(
    (item) =>
      item.decision.allowed !== true &&
      !TERMINAL_QUEUE_STATES.has(item.queueState),
  );
  const scheduledItems = items.filter((item) => item.scheduled === true);
  const plannedItems = items.filter((item) => item.planned === true);
  const runningItems = items.filter(
    (item) =>
      item.queueState === "running" ||
      item.queueState === "building_integration",
  );
  const stackBlockedItems = items.filter(
    (item) =>
      item.stack?.stackBlocked === true &&
      !TERMINAL_QUEUE_STATES.has(item.queueState),
  );
  const blockerGroups = aggregateReasons(
    blockedItems.flatMap((item) =>
      arrayValue(item.decision.blockers).map((reason) => ({
        reason,
        item,
        requiredActions: item.decision.requiredActions,
      })),
    ),
  );
  const batchSkipGroups = aggregateReasons(
    arrayValue(batchEligibility.skippedItems).map((item) => ({
      reason: item.reason ?? "not_selected",
      item,
      requiredActions: [],
    })),
  );
  const requiredActions = aggregateActions(
    blockedItems.flatMap((item) =>
      arrayValue(item.decision.requiredActions).map((action) => ({
        action,
        item,
      })),
    ),
  );
  const agentActions = aggregateAgentActions(blockedItems);
  const stuckLanes = lanes
    .filter(
      (lane) =>
        lane.state === "blocked" ||
        (lane.state === "busy" && lane.planned === 0),
    )
    .map((lane) => ({
      key: lane.key,
      state: lane.state,
      repo: lane.repo,
      targetBranch: lane.targetBranch,
      blockedItemIds: lane.blockedItemIds,
      runningItemIds: lane.runningItemIds,
      requiredActions: requiredActionsForLane({ lane, items }),
    }));

  return {
    health: queueHealth({
      counts,
      scheduledItems,
      plannedItems,
      runningItems,
      blockedItems,
    }),
    nextAction: queueNextAction({
      counts,
      integration,
      plan,
      scheduledItems,
      plannedItems,
      runningItems,
      blockedItems,
    }),
    nextMergeTarget: nextMergeTarget({ plan, plannedItems, scheduledItems }),
    pressure: {
      blockedReasonCount: blockerGroups.length,
      batchSkipReasonCount: batchSkipGroups.length,
      requiredActionCount: requiredActions.length,
      stuckLaneCount: stuckLanes.length,
      stackCount: dependencies.stackCount ?? 0,
      stackBlockedItemCount: stackBlockedItems.length,
    },
    blockers: blockerGroups,
    batchSkips: batchSkipGroups,
    requiredActions,
    agentActions,
    stacks: stackDiagnostics({ dependencies, stackBlockedItems }),
    stuckLanes,
  };
}

function queueHealth({
  counts,
  scheduledItems,
  plannedItems,
  runningItems,
  blockedItems,
}) {
  if (counts.items === 0) return "empty";
  if (
    blockedItems.length > 0 &&
    scheduledItems.length === 0 &&
    runningItems.length === 0
  )
    return "blocked";
  if (plannedItems.length > 0)
    return blockedItems.length > 0 ? "attention" : "ready";
  if (runningItems.length > 0)
    return blockedItems.length > 0 ? "busy_attention" : "busy";
  if (scheduledItems.length > 0)
    return blockedItems.length > 0 ? "attention" : "ready";
  if (blockedItems.length > 0) return "blocked";
  return "idle";
}

function queueNextAction({
  counts,
  integration,
  plan,
  scheduledItems,
  plannedItems,
  runningItems,
  blockedItems,
}) {
  if (counts.items === 0) return "observe_queue";
  if (
    plannedItems.length > 0 &&
    integration.enabled === true &&
    plan.dryRun === false
  )
    return "execute_selected_plan";
  if (plannedItems.length > 0 && integration.enabled === true)
    return "review_dry_run_plan";
  if (plannedItems.length > 0 || scheduledItems.length > 0)
    return "enable_or_run_integration";
  if (runningItems.length > 0) return "wait_for_active_run";
  if (blockedItems.length > 0) return "resolve_queue_blockers";
  return "wait_for_ready_items";
}

function nextMergeTarget({ plan, plannedItems, scheduledItems }) {
  const firstPlan = arrayValue(plan.plans)[0];
  const fallback = plannedItems[0] ?? scheduledItems[0];
  if (!firstPlan && !fallback) return null;
  return dropUndefined({
    repo: firstPlan?.repo ?? fallback?.repo,
    pullRequestId: firstPlan?.pullRequestId ?? fallback?.pullRequestId,
    targetBranch: firstPlan?.targetBranch ?? fallback?.targetBranch,
    ownerAgentId: fallback?.ownerAgentId,
    queuePosition: firstPlan?.queuePosition ?? fallback?.queuePosition,
    integrationBranch: firstPlan?.integrationBranch,
    requiredChecks: firstPlan?.requiredChecks ?? [],
  });
}

function aggregateReasons(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const reason = entry.reason ?? "unknown";
    const group = groups.get(reason) ?? {
      reason,
      count: 0,
      itemIds: [],
      pullRequests: [],
      requiredActions: new Set(),
    };
    group.count += 1;
    group.itemIds.push(itemIdentity(entry.item));
    if (entry.item?.repo && entry.item?.pullRequestId != null) {
      group.pullRequests.push({
        repo: entry.item.repo,
        pullRequestId: entry.item.pullRequestId,
      });
    }
    for (const action of arrayValue(entry.requiredActions)) {
      group.requiredActions.add(action);
    }
    groups.set(reason, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      itemIds: unique(group.itemIds).slice(0, 10),
      pullRequests: uniquePullRequests(group.pullRequests).slice(0, 10),
      requiredActions: [...group.requiredActions].sort(),
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        String(left.reason).localeCompare(String(right.reason)),
    );
}

function aggregateActions(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const action = entry.action ?? "unknown";
    const group = groups.get(action) ?? { action, count: 0, itemIds: [] };
    group.count += 1;
    group.itemIds.push(itemIdentity(entry.item));
    groups.set(action, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, itemIds: unique(group.itemIds).slice(0, 10) }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        String(left.action).localeCompare(String(right.action)),
    );
}

function aggregateAgentActions(items = []) {
  const groups = new Map();
  for (const item of items) {
    const ownerAgentId = item.ownerAgentId ?? "unassigned";
    const group = groups.get(ownerAgentId) ?? {
      ownerAgentId,
      blocked: 0,
      itemIds: [],
      requiredActions: new Set(),
    };
    group.blocked += 1;
    group.itemIds.push(itemIdentity(item));
    for (const action of arrayValue(item.decision.requiredActions)) {
      group.requiredActions.add(action);
    }
    groups.set(ownerAgentId, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ownerAgentId: group.ownerAgentId,
      blocked: group.blocked,
      itemIds: unique(group.itemIds).slice(0, 10),
      requiredActions: [...group.requiredActions].sort(),
    }))
    .sort(
      (left, right) =>
        right.blocked - left.blocked ||
        String(left.ownerAgentId).localeCompare(String(right.ownerAgentId)),
    );
}

function stackDiagnostics({ dependencies = {}, stackBlockedItems = [] }) {
  return {
    stackCount: dependencies.stackCount ?? 0,
    stackedItemCount: dependencies.stackedItemCount ?? 0,
    blockedItemCount: stackBlockedItems.length,
    missingDependencyCount: dependencies.missingDependencyCount ?? 0,
    cycleCount: dependencies.cycleCount ?? 0,
    blockedItems: stackBlockedItems.map((item) => ({
      id: item.id,
      repo: item.repo,
      pullRequestId: item.pullRequestId,
      state: item.stack?.state ?? null,
      blockingDependencies: item.stack?.blockingDependencies ?? [],
      requiredActions: item.stack?.requiredActions ?? [],
    })),
    stacks: arrayValue(dependencies.stacks).map((stack) => ({
      id: stack.id,
      repo: stack.repo,
      state: stack.state,
      itemIds: stack.itemIds,
      blockedItemIds: stack.blockedItemIds,
      nextMergeItemId: stack.nextMergeItemId,
      requiredActions: stack.requiredActions,
    })),
  };
}

function dependencyDiagnostics(dependencies) {
  return {
    stackCount: dependencies.stackCount,
    stackedItemCount: dependencies.stackedItemCount,
    blockedItemCount: dependencies.blockedItemCount,
    missingDependencyCount: dependencies.missingDependencyCount,
    cycleCount: dependencies.cycleCount,
    stacks: dependencies.stacks,
  };
}

function requiredActionsForLane({ lane, items }) {
  const laneItemIds = new Set([
    ...arrayValue(lane.blockedItemIds),
    ...arrayValue(lane.runningItemIds),
  ]);
  return unique(
    items
      .filter((item) => laneItemIds.has(itemIdentity(item)))
      .flatMap((item) => arrayValue(item.decision?.requiredActions)),
  ).sort();
}

function summarizeLanes({ evaluatedItems, scheduled, plan, policy, config }) {
  const groups = new Map();
  for (const evaluated of evaluatedItems) {
    const laneKey = queueLaneKey(evaluated.item);
    const group = groups.get(laneKey) ?? {
      key: laneKey,
      repo: evaluated.item.repo ?? null,
      targetBranch: evaluated.item.targetBranch ?? null,
      evaluatedItems: [],
      scheduled: [],
    };
    group.evaluatedItems.push(evaluated);
    groups.set(laneKey, group);
  }

  for (const item of scheduled) {
    const laneKey = queueLaneKey(item);
    const group = groups.get(laneKey);
    if (group) group.scheduled.push(item);
  }

  const plannedByLane = new Map();
  for (const entry of plan.plans) {
    const laneKey = `${entry.repo ?? "unknown"}:${entry.targetBranch ?? ""}`;
    plannedByLane.set(laneKey, [...(plannedByLane.get(laneKey) ?? []), entry]);
  }

  return [...groups.values()]
    .map((group) => {
      const lanePlan = buildIntegrationPlan({
        items: group.evaluatedItems.map(({ item }) => item),
        policy,
        config,
      });
      const blocked = group.evaluatedItems.filter(
        ({ item, decision }) =>
          !decision.allowed && !TERMINAL_QUEUE_STATES.has(item.queueState),
      );
      const running = group.evaluatedItems.filter(
        ({ item }) =>
          item.queueState === "running" ||
          item.queueState === "building_integration",
      );
      const planned = plannedByLane.get(group.key) ?? [];
      const laneSkipped = lanePlan.skippedItems;
      return {
        key: group.key,
        repo: group.repo,
        targetBranch: group.targetBranch,
        state: laneState({
          scheduled: group.scheduled,
          blocked,
          running,
          planned,
        }),
        total: group.evaluatedItems.length,
        scheduled: group.scheduled.length,
        planned: planned.length,
        blocked: blocked.length,
        running: running.length,
        batch: lanePlan.batch,
        batchCandidateItemIds: lanePlan.plans.map(
          (entry) => `${entry.repo}#${entry.pullRequestId}`,
        ),
        batchSkippedItems: laneSkipped,
        batchSkippedItemIds: laneSkipped.map(
          (item) => item.id ?? `${item.repo}#${item.pullRequestId}`,
        ),
        leadItemId: group.scheduled[0]?.id ?? null,
        plannedItemIds: planned.map(
          (entry) => `${entry.repo}#${entry.pullRequestId}`,
        ),
        blockedItemIds: blocked.map(
          ({ item }) => item.id ?? `${item.repo}#${item.pullRequestId}`,
        ),
        runningItemIds: running.map(
          ({ item }) => item.id ?? `${item.repo}#${item.pullRequestId}`,
        ),
      };
    })
    .sort(
      (left, right) =>
        String(left.repo ?? "").localeCompare(String(right.repo ?? "")) ||
        String(left.targetBranch ?? "").localeCompare(
          String(right.targetBranch ?? ""),
        ),
    );
}

function itemSummary({
  item,
  decision,
  stack,
  scheduledItem,
  scheduledIds,
  plannedIds,
  batchEligibility,
}) {
  const key = queueItemIdentity(item);
  return {
    id: item.id ?? null,
    repo: item.repo ?? null,
    pullRequestId: item.pullRequestId ?? null,
    targetBranch: item.targetBranch ?? null,
    ownerAgentId: item.ownerAgentId ?? null,
    queueState: item.queueState ?? null,
    priority: numberOrZero(item.priority),
    laneKey: queueLaneKey(item),
    scheduled: scheduledIds.has(key),
    planned: plannedIds.has(`${item.repo}#${item.pullRequestId}`),
    stack:
      stack && stack.state !== "independent"
        ? {
            state: stack.state,
            stackBlocked: stack.stackBlocked,
            dependencies: stack.dependencies,
            dependents: stack.dependents,
            blockingDependencies: stack.blockingDependencies,
            requiredActions: stack.requiredActions,
            nextActions: stack.nextActions,
          }
        : null,
    batchEligibility: scheduledIds.has(key)
      ? (batchEligibility ?? {
          key,
          eligible: false,
          selected: false,
          reason: "not_evaluated",
        })
      : null,
    queuePosition: scheduledItem?.queuePosition ?? null,
    decision: {
      allowed: decision.allowed,
      state: decision.state,
      blockers: decision.blockers,
      requiredActions: decision.requiredActions,
      risk: decision.risk,
      conflict: decision.conflict,
      policyOverride: decision.policyOverride ?? null,
    },
  };
}

function laneState({ scheduled, blocked, running, planned }) {
  if (running.length > 0) return "busy";
  if (planned.length > 0) return "planned";
  if (scheduled.length > 0) return "ready";
  if (blocked.length > 0) return "blocked";
  return "idle";
}

function matchesFilters(item, filters) {
  if (filters.repo && item.repo !== filters.repo) return false;
  if (filters.targetBranch && item.targetBranch !== filters.targetBranch)
    return false;
  return true;
}

function normalizeFilters({ repo, targetBranch }) {
  return {
    repo: repo ? String(repo) : null,
    targetBranch: targetBranch ? String(targetBranch) : null,
  };
}

function queueLaneKey(item) {
  return `${item.repo ?? "unknown"}:${item.targetBranch ?? ""}`;
}

function queueItemIdentity(item) {
  if (item.repo && item.pullRequestId != null)
    return `${item.repo}#${item.pullRequestId}`;
  return String(item.id ?? "");
}

function itemIdentity(item) {
  if (!item) return "";
  return item.id ?? queueItemIdentity(item);
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
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

function uniquePullRequests(pullRequests = []) {
  const seen = new Set();
  const uniqueItems = [];
  for (const pullRequest of pullRequests) {
    const key = `${pullRequest.repo}#${pullRequest.pullRequestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueItems.push(pullRequest);
  }
  return uniqueItems;
}

function dropUndefined(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

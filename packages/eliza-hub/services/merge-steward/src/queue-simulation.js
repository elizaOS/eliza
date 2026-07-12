import { buildMergeQueueSummary } from "./merge-queue-summary.js";

export function buildQueueSimulation({
  currentItems = [],
  proposedItem,
  proposedItems,
  items,
  policy,
  config = {},
  now = new Date().toISOString(),
  repo,
  targetBranch,
} = {}) {
  const filters = normalizeFilters({ repo, targetBranch });
  const proposals = normalizeProposals({
    proposedItem,
    proposedItems: proposedItems ?? items,
    currentItems,
    filters,
  });
  const baseline = buildMergeQueueSummary({
    queueItems: currentItems,
    policy,
    config,
    now,
    repo: filters.repo,
    targetBranch: filters.targetBranch,
  });
  const simulated = buildMergeQueueSummary({
    queueItems: [...currentItems, ...proposals],
    policy,
    config,
    now,
    repo: filters.repo,
    targetBranch: filters.targetBranch,
  });
  const proposed = proposals.map((item, index) =>
    proposedOutcome({
      item,
      index,
      simulated,
    }),
  );
  const impact = buildImpact({ baseline, simulated, proposals, proposed });

  return {
    computedAt: now,
    readOnly: true,
    filters: baseline.filters,
    proposedCount: proposals.length,
    proposed,
    impact,
    baseline: compactQueueSummary(baseline),
    simulated: compactQueueSummary(simulated),
    nextActions: buildNextActions({ proposed, impact, simulated }),
  };
}

function normalizeProposals({
  proposedItem,
  proposedItems,
  currentItems,
  filters,
}) {
  const raw = [];
  if (Array.isArray(proposedItems)) raw.push(...proposedItems);
  if (proposedItem && typeof proposedItem === "object") raw.push(proposedItem);

  const existingIds = new Set(
    currentItems
      .map((item) => item.id)
      .filter(Boolean)
      .map(String),
  );
  const seenIds = new Set(existingIds);
  return raw
    .filter((item) => item && typeof item === "object")
    .map((item, index) =>
      withSimulationIdentity(item, index, filters, seenIds),
    );
}

function withSimulationIdentity(item, index, filters, seenIds) {
  const repo = stringOrNull(item.repo) ?? filters.repo ?? "";
  const pullRequestId =
    item.pullRequestId ??
    item.number ??
    item.prNumber ??
    `proposed-${index + 1}`;
  const targetBranch =
    stringOrNull(item.targetBranch) ?? filters.targetBranch ?? "";
  const baseId =
    stringOrNull(item.id) ?? `simulation:${repo || "repo"}#${pullRequestId}`;
  const id = uniqueSimulationId(baseId, index, seenIds);
  seenIds.add(id);

  return {
    ...item,
    id,
    repo,
    pullRequestId,
    targetBranch,
    simulation: {
      source: "proposed",
      index,
      originalId: item.id ?? null,
    },
  };
}

function uniqueSimulationId(baseId, index, seenIds) {
  let candidate = String(baseId);
  if (!seenIds.has(candidate)) return candidate;

  candidate = `simulation:${index + 1}:${candidate}`;
  let suffix = 2;
  while (seenIds.has(candidate)) {
    candidate = `simulation:${index + 1}:${baseId}:${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function proposedOutcome({ item, index, simulated }) {
  const summary =
    simulated.items.find((candidate) => candidate.id === item.id) ?? null;
  const plan =
    arrayValue(simulated.selectedPlan?.plans).find(
      (entry) =>
        entry.repo === item.repo &&
        String(entry.pullRequestId) === String(item.pullRequestId),
    ) ?? null;
  const allowed = summary?.decision?.allowed === true;
  const scheduled = summary?.scheduled === true;
  const planned = summary?.planned === true;

  return {
    id: item.id,
    index,
    repo: item.repo || null,
    pullRequestId: item.pullRequestId ?? null,
    targetBranch: item.targetBranch || null,
    ownerAgentId: item.ownerAgentId ?? null,
    laneKey: summary?.laneKey ?? laneKey(item),
    outcome: planned
      ? "selected_for_integration"
      : scheduled
        ? "queued"
        : allowed
          ? "allowed_not_scheduled"
          : "blocked",
    scheduled,
    planned,
    queuePosition: summary?.queuePosition ?? null,
    stack: summary?.stack ?? null,
    batchEligibility: summary?.batchEligibility ?? null,
    decision: summary?.decision ?? null,
    integrationPlan: plan,
  };
}

function buildImpact({ baseline, simulated, proposals, proposed }) {
  const proposedIds = new Set(proposals.map((item) => item.id));
  const baselineById = new Map(
    baseline.items.map((item) => [summaryIdentity(item), item]),
  );
  const simulatedById = new Map(
    simulated.items
      .filter((item) => !proposedIds.has(item.id))
      .map((item) => [summaryIdentity(item), item]),
  );
  const displacedItems = [];

  for (const [id, before] of baselineById) {
    const after = simulatedById.get(id);
    if (!after) continue;

    const queuePositionChanged =
      numeric(after.queuePosition) > numeric(before.queuePosition);
    const plannedChanged = before.planned === true && after.planned !== true;
    const scheduledChanged =
      before.scheduled === true && after.scheduled !== true;

    if (queuePositionChanged || plannedChanged || scheduledChanged) {
      displacedItems.push({
        id: before.id ?? id,
        repo: before.repo,
        pullRequestId: before.pullRequestId,
        beforeQueuePosition: before.queuePosition,
        afterQueuePosition: after.queuePosition,
        beforePlanned: before.planned,
        afterPlanned: after.planned,
        reason: plannedChanged
          ? "removed_from_selected_plan"
          : scheduledChanged
            ? "removed_from_schedule"
            : "queue_position_increased",
      });
    }
  }

  return {
    proposed: {
      total: proposed.length,
      allowed: proposed.filter((item) => item.decision?.allowed === true)
        .length,
      blocked: proposed.filter((item) => item.decision?.allowed === false)
        .length,
      scheduled: proposed.filter((item) => item.scheduled).length,
      planned: proposed.filter((item) => item.planned).length,
    },
    queue: {
      baselineItems: baseline.counts.items,
      simulatedItems: simulated.counts.items,
      scheduledDelta: simulated.counts.scheduled - baseline.counts.scheduled,
      plannedDelta: simulated.counts.planned - baseline.counts.planned,
      blockedDelta: simulated.counts.blocked - baseline.counts.blocked,
      stackDelta:
        (simulated.dependencies?.stackCount ?? 0) -
        (baseline.dependencies?.stackCount ?? 0),
      stackBlockedItemDelta:
        (simulated.dependencies?.blockedItemCount ?? 0) -
        (baseline.dependencies?.blockedItemCount ?? 0),
    },
    selectedPlanChanged:
      planSignature(baseline.selectedPlan) !==
      planSignature(simulated.selectedPlan),
    displacedItems,
    skippedProposedItems: proposed
      .filter((item) => item.scheduled && !item.planned)
      .map((item) => ({
        id: item.id,
        repo: item.repo,
        pullRequestId: item.pullRequestId,
        reason: item.batchEligibility?.reason ?? "not_selected",
      })),
  };
}

function compactQueueSummary(summary) {
  return {
    counts: summary.counts,
    integration: summary.integration,
    selectedPlan: summary.selectedPlan,
    dependencies: summary.dependencies,
    diagnostics: summary.diagnostics,
    lanes: summary.lanes,
  };
}

function buildNextActions({ proposed, impact, simulated }) {
  if (proposed.length === 0) {
    return [
      action({
        id: "provide_proposed_items",
        priority: 100,
        reason:
          "Queue simulation needs proposedItem or proposedItems to predict enqueue impact.",
      }),
    ];
  }

  const actions = [];

  if (impact.proposed.blocked > 0) {
    actions.push(
      action({
        id: "resolve_proposed_blockers",
        priority: 90,
        reason: "At least one proposed item would be blocked by queue policy.",
      }),
    );
  }

  if (impact.proposed.planned > 0) {
    actions.push(
      action({
        id:
          simulated.integration.enabled &&
          simulated.integration.dryRun === false
            ? "ready_for_integration_execution"
            : "review_simulated_integration_plan",
        priority: 70,
        reason:
          "A proposed item would be selected by the current integration plan.",
      }),
    );
  } else if (impact.proposed.scheduled > 0) {
    actions.push(
      action({
        id: "queue_proposed_items",
        priority: 55,
        reason:
          "Proposed items pass policy but would wait behind current queue work.",
      }),
    );
  }

  if (impact.displacedItems.length > 0) {
    actions.push(
      action({
        id: "review_displaced_queue_items",
        priority: 45,
        reason:
          "The simulation moves existing queued or planned work behind proposed items.",
      }),
    );
  }

  if (
    impact.queue.stackDelta > 0 ||
    impact.queue.stackBlockedItemDelta > 0 ||
    proposed.some((item) => item.stack?.stackBlocked === true)
  ) {
    actions.push(
      action({
        id: "review_stack_dependencies",
        priority: 40,
        reason:
          "The simulation creates or blocks stacked PR dependencies that must merge in order.",
      }),
    );
  }

  if (actions.length === 0) {
    actions.push(
      action({
        id: "observe_simulation",
        priority: 10,
        reason: "Simulation completed without a schedulable proposed item.",
      }),
    );
  }

  return actions.sort(
    (left, right) =>
      right.priority - left.priority || left.id.localeCompare(right.id),
  );
}

function action({ id, priority, reason }) {
  return { id, priority, reason };
}

function planSignature(plan = {}) {
  return arrayValue(plan.plans)
    .map(
      (entry) =>
        `${entry.repo}#${entry.pullRequestId}:${entry.queuePosition ?? ""}`,
    )
    .join("|");
}

function summaryIdentity(item) {
  if (item.id) return String(item.id);
  if (item.repo && item.pullRequestId != null)
    return `${item.repo}#${item.pullRequestId}`;
  return "";
}

function laneKey(item) {
  return `${item.repo || "unknown"}:${item.targetBranch || ""}`;
}

function normalizeFilters({ repo, targetBranch }) {
  return {
    repo: stringOrNull(repo),
    targetBranch: stringOrNull(targetBranch),
  };
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NEGATIVE_INFINITY;
}

function stringOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

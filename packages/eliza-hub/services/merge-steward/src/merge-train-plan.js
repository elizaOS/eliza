import { buildMergeQueueSummary } from "./merge-queue-summary.js";

export function buildMergeTrainPlan({
  queueItems = [],
  policy,
  config = {},
  now = new Date().toISOString(),
  repo,
  targetBranch,
  maxLanes = 20,
  maxLaneItems = 20,
} = {}) {
  const summary = buildMergeQueueSummary({
    queueItems,
    policy,
    config,
    now,
    repo,
    targetBranch,
  });
  const laneLimit = positiveInteger(maxLanes, 20);
  const itemLimit = positiveInteger(maxLaneItems, 20);
  const selectedTrain = buildSelectedTrain(summary);
  const preflight = buildTrainPreflight({ summary, selectedTrain });

  return {
    schema: "https://eliza.hub/schemas/merge-train-plan.v1",
    computedAt: now,
    readOnly: true,
    filters: summary.filters,
    status: planStatus({ summary, selectedTrain }),
    integration: summary.integration,
    queue: {
      health: summary.diagnostics.health,
      nextAction: summary.diagnostics.nextAction,
      nextMergeTarget: summary.diagnostics.nextMergeTarget,
      counts: summary.counts,
      pressure: summary.diagnostics.pressure,
      blockers: summary.diagnostics.blockers,
      batchSkips: summary.diagnostics.batchSkips,
      stacks: summary.diagnostics.stacks,
    },
    selectedTrain,
    preflight,
    lanes: summary.lanes.slice(0, laneLimit).map((lane) =>
      lanePlan({
        lane,
        items: summary.items,
        maxLaneItems: itemLimit,
      }),
    ),
    safety: {
      mutatesState: false,
      executesIntegration: false,
      mergeAuthority: "queue_run_once_only",
      liveExecutionRequires: [
        "MERGE_STEWARD_INTEGRATION_ENABLED=true",
        "MERGE_STEWARD_INTEGRATION_DRY_RUN=false",
        "MERGE_STEWARD_WORKER_ENABLED=true",
        "MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION=true",
        "protected_target_branch",
        "fresh_required_checks",
        "matching_pr_head_sha",
      ],
    },
    links: {
      mergeQueue: "/api/merge-queue",
      queueRunOnce: "/api/queue/run-once",
      releaseReadiness: "/api/release-readiness",
      repositoryProtection: "/api/repository-protection",
    },
    labels: planLabels({ summary, selectedTrain }),
  };
}

function buildSelectedTrain(summary) {
  const plans = arrayValue(summary.selectedPlan?.plans);
  const firstPlan = plans[0] ?? null;
  const laneKey = firstPlan
    ? `${firstPlan.repo ?? "unknown"}:${firstPlan.targetBranch ?? ""}`
    : null;
  const itemIds = plans.map((plan) => `${plan.repo}#${plan.pullRequestId}`);
  const requiredChecks = unique(
    plans.flatMap((plan) => arrayValue(plan.requiredChecks)),
  );
  const blockers = selectedTrainBlockers({ summary, plans, laneKey });

  return {
    id: firstPlan
      ? trainId({
          repo: firstPlan.repo,
          targetBranch: firstPlan.targetBranch,
          itemIds,
        })
      : null,
    laneKey,
    repo: firstPlan?.repo ?? null,
    targetBranch: firstPlan?.targetBranch ?? null,
    mode: summary.selectedPlan?.strategy ?? "single-pr",
    enabled: summary.selectedPlan?.enabled === true,
    dryRun: summary.selectedPlan?.dryRun !== false,
    executionReady: plans.length > 0 && blockers.length === 0,
    planCount: plans.length,
    itemIds,
    pullRequests: plans.map((plan) => ({
      repo: plan.repo,
      pullRequestId: plan.pullRequestId,
      ownerAgentId: itemForPlan(summary.items, plan)?.ownerAgentId ?? null,
      queuePosition: plan.queuePosition ?? null,
      targetBranch: plan.targetBranch ?? null,
      sourceBranch: plan.sourceBranch ?? null,
      headSha: plan.headSha ?? null,
      integrationBranch: plan.integrationBranch ?? null,
      requiredChecks: arrayValue(plan.requiredChecks),
    })),
    integrationBranches: unique(
      plans.map((plan) => plan.integrationBranch).filter(Boolean),
    ),
    requiredChecks,
    actions: plans.flatMap((plan) =>
      arrayValue(plan.actions).map((action) => ({
        ...action,
        repo: plan.repo,
        pullRequestId: plan.pullRequestId,
        itemId: `${plan.repo}#${plan.pullRequestId}`,
      })),
    ),
    blockers,
    nextAction: selectedTrainNextAction({ plans, blockers, summary }),
    skippedItems: summary.selectedPlan?.skippedItems ?? [],
    reason: summary.selectedPlan?.reason ?? null,
  };
}

function selectedTrainBlockers({ summary, plans, laneKey }) {
  const blockers = [];
  if (plans.length === 0) blockers.push("no_selected_plan");
  if (summary.integration.enabled !== true)
    blockers.push("integration_disabled");
  if (summary.integration.dryRun !== false)
    blockers.push("integration_dry_run");
  if (
    summary.integration.allowEmptyRequiredChecks !== true &&
    plans.some((plan) => arrayValue(plan.requiredChecks).length === 0)
  ) {
    blockers.push("required_checks_missing");
  }
  if (summary.lanes.some((lane) => lane.key === laneKey && lane.running > 0))
    blockers.push("lane_has_active_work");
  return unique(blockers);
}

function selectedTrainNextAction({ plans, blockers, summary }) {
  if (plans.length === 0 && summary.counts.blocked > 0)
    return "resolve_queue_blockers";
  if (plans.length === 0) return "wait_for_ready_items";
  if (blockers.includes("integration_disabled"))
    return "enable_integration_after_production_gate";
  if (blockers.includes("required_checks_missing"))
    return "configure_required_checks";
  if (blockers.includes("integration_dry_run")) return "review_dry_run_train";
  if (blockers.includes("lane_has_active_work")) return "wait_for_active_lane";
  return "execute_queue_run_once";
}

function buildTrainPreflight({ summary, selectedTrain }) {
  const checks = [
    selectedTrainCheck({ summary, selectedTrain }),
    integrationEnabledCheck({ summary, selectedTrain }),
    dryRunModeCheck({ summary, selectedTrain }),
    laneIdleCheck({ summary, selectedTrain }),
    requiredChecksCheck({ summary, selectedTrain }),
    queueBlockersCheck({ summary }),
    stackOrderCheck({ summary }),
  ];
  const hardFailures = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");

  return {
    status: preflightStatus({ summary, hardFailures, warnings }),
    liveExecutionReady:
      selectedTrain.executionReady === true && hardFailures.length === 0,
    dryRunReviewReady:
      selectedTrain.planCount > 0 &&
      summary.integration.enabled === true &&
      summary.integration.dryRun !== false &&
      hardFailures.length === 0,
    checks,
    blockers: unique(hardFailures.map((check) => check.name)),
    warnings: unique(warnings.map((check) => check.name)),
    requiredActions: unique(checks.flatMap((check) => check.requiredActions)),
  };
}

function selectedTrainCheck({ summary, selectedTrain }) {
  if (summary.counts.items === 0) {
    return check(
      "selected_train",
      "skip",
      "info",
      "No queue items are in scope.",
      {
        queueItems: 0,
      },
      ["observe_queue"],
    );
  }
  if (selectedTrain.planCount === 0) {
    return check(
      "selected_train",
      "fail",
      "high",
      "No merge train is selected.",
      {
        queueItems: summary.counts.items,
        scheduled: summary.counts.scheduled,
        blocked: summary.counts.blocked,
        reason: selectedTrain.reason,
      },
      summary.counts.blocked > 0
        ? ["resolve_queue_blockers"]
        : ["wait_for_ready_items"],
    );
  }
  return check("selected_train", "pass", "info", "A merge train is selected.", {
    planCount: selectedTrain.planCount,
    mode: selectedTrain.mode,
    itemIds: selectedTrain.itemIds,
  });
}

function integrationEnabledCheck({ summary, selectedTrain }) {
  if (selectedTrain.planCount === 0) {
    return check(
      "integration_enabled",
      "skip",
      "info",
      "No selected train needs integration planning.",
      {
        enabled: summary.integration.enabled === true,
      },
    );
  }
  if (summary.integration.enabled === true) {
    return check(
      "integration_enabled",
      "pass",
      "info",
      "Integration planning is enabled.",
      {
        executor: summary.integration.executor,
      },
    );
  }
  return check(
    "integration_enabled",
    "fail",
    "high",
    "Integration planning is disabled.",
    {
      executor: summary.integration.executor,
    },
    ["enable_merge_steward_integration"],
  );
}

function dryRunModeCheck({ summary, selectedTrain }) {
  if (selectedTrain.planCount === 0) {
    return check(
      "live_execution_enabled",
      "skip",
      "info",
      "No selected train needs live-execution confirmation.",
      {
        dryRun: summary.integration.dryRun !== false,
      },
    );
  }
  if (summary.integration.dryRun === false) {
    return check(
      "live_execution_enabled",
      "pass",
      "info",
      "Live merge execution is enabled.",
      {
        dryRun: false,
      },
    );
  }
  return check(
    "live_execution_enabled",
    "warn",
    "medium",
    "Integration is still in dry-run mode.",
    {
      dryRun: true,
    },
    ["review_dry_run_train", "confirm_live_merge_before_cutover"],
  );
}

function laneIdleCheck({ summary, selectedTrain }) {
  const lane = summary.lanes.find(
    (candidate) => candidate.key === selectedTrain.laneKey,
  );
  if (!lane) {
    return check(
      "selected_lane_idle",
      selectedTrain.planCount > 0 ? "fail" : "skip",
      "medium",
      "No selected merge lane was found.",
      {
        laneKey: selectedTrain.laneKey,
      },
      selectedTrain.planCount > 0 ? ["refresh_queue_state"] : [],
    );
  }
  if (lane.running > 0) {
    return check(
      "selected_lane_idle",
      "fail",
      "medium",
      "The selected merge lane already has active work.",
      {
        laneKey: lane.key,
        runningItemIds: lane.runningItemIds,
      },
      ["wait_for_active_lane"],
    );
  }
  return check(
    "selected_lane_idle",
    "pass",
    "info",
    "The selected merge lane is idle.",
    {
      laneKey: lane.key,
    },
  );
}

function requiredChecksCheck({ summary, selectedTrain }) {
  if (selectedTrain.planCount === 0) {
    return check(
      "required_checks_declared",
      "skip",
      "info",
      "No selected PRs need required-check validation.",
      {},
    );
  }
  const missing = selectedTrain.pullRequests
    .filter(
      (pullRequest) => arrayValue(pullRequest.requiredChecks).length === 0,
    )
    .map((pullRequest) => `${pullRequest.repo}#${pullRequest.pullRequestId}`);
  if (
    missing.length > 0 &&
    summary.integration.allowEmptyRequiredChecks !== true
  ) {
    return check(
      "required_checks_declared",
      "fail",
      "high",
      "Selected PRs are missing required checks.",
      {
        itemIds: missing,
        allowEmptyRequiredChecks: false,
      },
      ["configure_required_checks"],
    );
  }
  if (missing.length > 0) {
    return check(
      "required_checks_declared",
      "warn",
      "medium",
      "Selected PRs have no required checks, but empty checks are explicitly allowed.",
      {
        itemIds: missing,
        allowEmptyRequiredChecks: true,
      },
      ["review_empty_required_check_policy"],
    );
  }
  return check(
    "required_checks_declared",
    "pass",
    "info",
    "Every selected PR declares required checks.",
    {
      requiredChecks: selectedTrain.requiredChecks,
    },
  );
}

function queueBlockersCheck({ summary }) {
  if (summary.counts.blocked > 0) {
    return check(
      "queue_blockers_clear",
      "warn",
      "medium",
      "The queue still has blocked items outside the selected train.",
      {
        blocked: summary.counts.blocked,
        blockerReasons: summary.diagnostics.blockers.map(
          (blocker) => blocker.reason,
        ),
      },
      ["triage_blocked_queue_items"],
    );
  }
  return check(
    "queue_blockers_clear",
    "pass",
    "info",
    "No blocked queue items are in scope.",
    {
      blocked: 0,
    },
  );
}

function stackOrderCheck({ summary }) {
  const blocked = summary.diagnostics.pressure.stackBlockedItemCount;
  if (blocked > 0) {
    return check(
      "stack_dependency_order",
      "warn",
      "medium",
      "Some stacked PRs are waiting for parent PRs.",
      {
        blocked,
        nextMergeItemIds: summary.diagnostics.stacks.stacks
          .map((stack) => stack.nextMergeItemId)
          .filter(Boolean),
      },
      ["merge_stack_parents_first"],
    );
  }
  return check(
    "stack_dependency_order",
    "pass",
    "info",
    "Stack dependency order is clear for the selected train.",
    {
      blocked: 0,
    },
  );
}

function preflightStatus({ summary, hardFailures, warnings }) {
  if (summary.counts.items === 0) return "empty";
  if (hardFailures.length > 0) return "blocked";
  if (warnings.some((warning) => warning.name === "live_execution_enabled"))
    return "dry_run_ready";
  return "live_ready";
}

function check(
  name,
  status,
  severity,
  summary,
  details = {},
  requiredActions = [],
) {
  return {
    name,
    status,
    severity,
    summary,
    details,
    requiredActions,
  };
}

function lanePlan({ lane, items, maxLaneItems }) {
  const laneItems = items.filter((item) => item.laneKey === lane.key);
  const scheduled = laneItems.filter((item) => item.scheduled === true);
  const planned = laneItems.filter((item) => item.planned === true);
  const blocked = laneItems.filter((item) => item.decision?.allowed !== true);
  const running = laneItems.filter(
    (item) =>
      item.queueState === "running" ||
      item.queueState === "building_integration",
  );

  return {
    key: lane.key,
    repo: lane.repo,
    targetBranch: lane.targetBranch,
    state: lane.state,
    nextAction: laneNextAction({ lane, scheduled, planned, blocked, running }),
    counts: {
      total: lane.total,
      scheduled: lane.scheduled,
      planned: lane.planned,
      blocked: lane.blocked,
      running: lane.running,
    },
    leadItemId: lane.leadItemId,
    trainCandidateItemIds: lane.batchCandidateItemIds,
    plannedItemIds: lane.plannedItemIds,
    skippedItems: lane.batchSkippedItems,
    blockedItems: blocked.slice(0, maxLaneItems).map(blockedItemRow),
    runningItemIds: lane.runningItemIds,
    readyItems: scheduled.slice(0, maxLaneItems).map(readyItemRow),
    batch: lane.batch,
  };
}

function laneNextAction({ lane, scheduled, planned, blocked, running }) {
  if (running.length > 0) return "wait_for_active_lane";
  if (planned.length > 0) return "execute_or_review_lane_train";
  if (scheduled.length > 0) return "select_lane_train";
  if (blocked.length > 0) return "resolve_lane_blockers";
  if (lane.total === 0) return "observe_lane";
  return "wait_for_ready_items";
}

function readyItemRow(item) {
  return {
    id: item.id,
    repo: item.repo,
    pullRequestId: item.pullRequestId,
    ownerAgentId: item.ownerAgentId,
    queuePosition: item.queuePosition,
    planned: item.planned,
    batchEligibility: item.batchEligibility,
    risk: item.decision?.risk ?? null,
    conflict: item.decision?.conflict ?? null,
  };
}

function blockedItemRow(item) {
  return {
    id: item.id,
    repo: item.repo,
    pullRequestId: item.pullRequestId,
    ownerAgentId: item.ownerAgentId,
    blockers: item.decision?.blockers ?? [],
    requiredActions: item.decision?.requiredActions ?? [],
    stack: item.stack ?? null,
  };
}

function planStatus({ summary, selectedTrain }) {
  if (summary.counts.items === 0) return "empty";
  if (selectedTrain.executionReady) return "ready_to_execute";
  if (selectedTrain.planCount > 0 && selectedTrain.dryRun)
    return "dry_run_ready";
  if (selectedTrain.planCount > 0) return "plan_blocked";
  if (summary.counts.running > 0) return "busy";
  if (summary.counts.blocked > 0) return "blocked";
  return "idle";
}

function planLabels({ summary, selectedTrain }) {
  const labels = [`merge-train:${planStatus({ summary, selectedTrain })}`];
  if (selectedTrain.mode === "batch") labels.push("merge-train:batch");
  if (summary.diagnostics.pressure.stackBlockedItemCount > 0)
    labels.push("merge-train:stack-blocked");
  if (summary.diagnostics.pressure.blockedReasonCount > 0)
    labels.push("merge-train:needs-attention");
  return unique(labels);
}

function itemForPlan(items, plan) {
  return items.find(
    (item) =>
      item.repo === plan.repo &&
      String(item.pullRequestId) === String(plan.pullRequestId),
  );
}

function trainId({ repo, targetBranch, itemIds }) {
  return `train:${slug(repo)}:${slug(targetBranch)}:${itemIds.map(slug).join("+")}`;
}

function slug(value) {
  return (
    String(value ?? "none")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "none"
  );
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
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

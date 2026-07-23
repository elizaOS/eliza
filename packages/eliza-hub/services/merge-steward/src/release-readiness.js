export const DEFAULT_RELEASE_READINESS_LIMITS = Object.freeze({
  maxBlockedItems: 0,
  maxRunningItems: 0,
  maxOpenHumanDecisions: 0,
  maxStaleClaims: 0,
  maxFailedRuns: 0,
  maxNeedsTriageAgents: 0,
  maxOverloadedAgents: 0,
  maxStackBlockedItems: 0,
});

export function buildReleaseReadiness({
  mergeQueue = {},
  routing = {},
  performance = {},
  workflow = null,
  readiness = null,
  repositoryProtection = null,
  now = mergeQueue?.computedAt ??
    routing?.computedAt ??
    performance?.computedAt ??
    new Date().toISOString(),
  repo = mergeQueue?.filters?.repo ??
    routing?.filters?.repo ??
    performance?.filters?.repo,
  targetBranch = mergeQueue?.filters?.targetBranch ??
    routing?.filters?.targetBranch ??
    performance?.filters?.targetBranch,
  requireLiveMerge = false,
  requireRoutableAgent = false,
  requireRepositoryProtection = false,
  limits = {},
} = {}) {
  const effectiveLimits = {
    ...DEFAULT_RELEASE_READINESS_LIMITS,
    ...objectValue(limits),
  };
  const counts = countsFor({ mergeQueue, routing, performance, workflow });
  const context = {
    counts,
    mergeQueue,
    routing,
    performance,
    workflow,
    readiness,
    repositoryProtection,
    limits: effectiveLimits,
    requireLiveMerge: requireLiveMerge === true,
    requireRoutableAgent: requireRoutableAgent === true,
    requireRepositoryProtection: requireRepositoryProtection === true,
  };
  const checks = [
    runtimeReadyCheck(context),
    ...strictWorkReservationChecks(context),
    ...repositoryProtectionChecks(context),
    stackDependencyCheck(context),
    queueBlockerCheck(context),
    queueLaneBusyCheck(context),
    integrationPlanCheck(context),
    liveMergeCheck(context),
    humanDecisionCheck(context),
    agentTriageCheck(context),
    routingCapacityCheck(context),
  ];
  const decision = decisionFor({ checks, counts, mergeQueue });

  return {
    computedAt: now,
    filters: {
      repo: repo ? String(repo) : null,
      targetBranch: targetBranch ? String(targetBranch) : null,
    },
    status: decision.status,
    canOpenMergeWindow: decision.canOpenMergeWindow,
    canAutoMerge: decision.canAutoMerge,
    canRouteNewAgentWork: decision.canRouteNewAgentWork,
    summary: decision.summary,
    counts,
    checks,
    labels: labelsFor({ decision, checks, mergeQueue }),
    requiredActions: unique(checks.flatMap((check) => check.requiredActions)),
    snapshots: {
      plannedItemIds: plannedItemIds(mergeQueue),
      blockedItemIds: blockedItemIds(mergeQueue),
      stackBlockedItemIds: stackBlockedItemIds(mergeQueue),
      stackNextMergeItemIds: stackNextMergeItemIds(mergeQueue),
      runningItemIds: runningItemIds(mergeQueue),
      blockedAgents: arrayValue(routing?.blockedAgents).slice(0, 10),
      routableAgents: arrayValue(routing?.routableAgents).slice(0, 10),
      repositoryProtection: repositoryProtectionSnapshot(repositoryProtection),
    },
  };
}

function countsFor({
  mergeQueue = {},
  routing = {},
  performance = {},
  workflow = null,
}) {
  const workflowCounts = workflow?.counts ?? {};
  const workflowCards = scopedWorkflowCards(
    workflow,
    mergeQueue?.filters ?? {},
  );
  const workflowSignalCounts =
    workflowCards.length > 0
      ? countsFromWorkflowCards(workflowCards)
      : {
          openHumanDecisions:
            numberOrZero(workflowCounts.openApprovals) +
            numberOrZero(workflowCounts.openHumanRequests),
          staleClaims: numberOrZero(workflowCounts.staleClaims),
          failedRuns: numberOrZero(workflowCounts.failedRuns),
        };
  return {
    queueItems: numberOrZero(mergeQueue?.counts?.items),
    scheduled: numberOrZero(mergeQueue?.counts?.scheduled),
    planned: numberOrZero(mergeQueue?.counts?.planned),
    blocked: numberOrZero(mergeQueue?.counts?.blocked),
    stackBlocked: stackBlockedItemCount(mergeQueue),
    running: numberOrZero(mergeQueue?.counts?.running),
    terminal: numberOrZero(mergeQueue?.counts?.terminal),
    recommendations: numberOrZero(routing?.counts?.recommendations),
    routableAgents: numberOrZero(routing?.counts?.routableAgents),
    blockedAgents: numberOrZero(routing?.counts?.blockedAgents),
    unassignedItems: numberOrZero(routing?.counts?.unassignedItems),
    openHumanDecisions: workflowSignalCounts.openHumanDecisions,
    staleClaims: Math.max(
      workflowSignalCounts.staleClaims,
      numberOrZero(performance?.counts?.staleClaims),
    ),
    failedRuns: Math.max(
      workflowSignalCounts.failedRuns,
      numberOrZero(performance?.counts?.failedRuns),
    ),
    needsTriageAgents: numberOrZero(performance?.counts?.needsTriage),
    overloadedAgents: numberOrZero(performance?.counts?.overloaded),
  };
}

function scopedWorkflowCards(workflow, filters = {}) {
  return arrayValue(workflow?.cards).filter((card) => {
    if (filters.repo && card.repo !== filters.repo) return false;
    if (filters.targetBranch && card.targetBranch !== filters.targetBranch)
      return false;
    return true;
  });
}

function countsFromWorkflowCards(cards) {
  return cards.reduce(
    (counts, card) => {
      counts.openHumanDecisions +=
        arrayValue(card.approvals).length +
        arrayValue(card.humanRequests).length;
      counts.staleClaims += arrayValue(card.claims).filter(
        (claim) => claim.status === "stale" || claim.stale === true,
      ).length;
      if (card.status === "failed" || card.runState?.state === "failed") {
        counts.failedRuns += 1;
      }
      return counts;
    },
    {
      openHumanDecisions: 0,
      staleClaims: 0,
      failedRuns: 0,
    },
  );
}

function runtimeReadyCheck({ readiness }) {
  if (!readiness) {
    return warn(
      "runtime_ready",
      "medium",
      "Runtime readiness was not included in the release check.",
      {},
      ["run_deployment_doctor"],
    );
  }
  if (readiness.ok === true) {
    return pass("runtime_ready", "Runtime readiness is healthy.", {
      deploymentMode: readiness.configuration?.deploymentMode ?? null,
    });
  }
  return fail(
    "runtime_ready",
    "critical",
    "Runtime readiness is failing.",
    {
      failedChecks: arrayValue(readiness.checks)
        .filter((check) => check.ok !== true)
        .map((check) => check.name),
    },
    ["fix_steward_readiness"],
  );
}

function strictWorkReservationChecks({ readiness }) {
  if (!readiness) return [];

  const configuration = readiness.configuration ?? {};
  const liveIntegrationActive =
    configuration.integrationEnabled === true &&
    configuration.integrationDryRun === false;
  const strictWorkReservations =
    configuration.requireWorkReservationForAgentPrs === true;
  const strictWorkItems = configuration.requireWorkItemForAgentPrs === true;
  const strictAgentBranchNamespaces =
    configuration.requireAgentBranchNamespaceForAgentPrs === true;
  const verifiedAgentRunReceipts =
    configuration.requireVerifiedAgentRunReceiptForAgentPrs === true;
  const agentIdentityRegistry =
    configuration.requireAgentIdentityRegistryForAgentPrs === true;
  const knownAgentIdCount = Number.isFinite(configuration.knownAgentIdCount)
    ? configuration.knownAgentIdCount
    : 0;
  const details = {
    deploymentMode: configuration.deploymentMode ?? null,
    liveIntegrationActive,
    integrationEnabled: configuration.integrationEnabled === true,
    integrationDryRun: configuration.integrationDryRun !== false,
    requireWorkReservationForAgentPrs: strictWorkReservations,
  };
  const workItemDetails = {
    ...details,
    requireWorkItemForAgentPrs: strictWorkItems,
  };
  const branchNamespaceDetails = {
    ...details,
    requireAgentBranchNamespaceForAgentPrs: strictAgentBranchNamespaces,
  };
  const runReceiptDetails = {
    ...details,
    requireVerifiedAgentRunReceiptForAgentPrs: verifiedAgentRunReceipts,
  };
  const identityRegistryDetails = {
    ...details,
    requireAgentIdentityRegistryForAgentPrs: agentIdentityRegistry,
    knownAgentIdCount,
  };
  const checks = [];

  if (liveIntegrationActive && !strictWorkReservations) {
    checks.push(
      fail(
        "strict_work_reservations",
        "critical",
        "Live merge execution requires strict agent work reservations.",
        details,
        ["enable_strict_work_reservations"],
      ),
    );
  } else {
    checks.push(
      pass(
        "strict_work_reservations",
        "Strict work-reservation posture is safe for the current integration mode.",
        details,
      ),
    );
  }

  if (liveIntegrationActive && !strictWorkItems) {
    checks.push(
      fail(
        "strict_work_items",
        "critical",
        "Live merge execution requires durable Work-item links for agent PRs.",
        workItemDetails,
        ["enable_strict_work_items"],
      ),
    );
  } else {
    checks.push(
      pass(
        "strict_work_items",
        "Strict Work-item posture is safe for the current integration mode.",
        workItemDetails,
      ),
    );
  }

  if (liveIntegrationActive && !strictAgentBranchNamespaces) {
    checks.push(
      fail(
        "strict_agent_branch_namespaces",
        "critical",
        "Live merge execution requires strict agent branch namespaces.",
        branchNamespaceDetails,
        ["enable_strict_agent_branch_namespaces"],
      ),
    );
  } else {
    checks.push(
      pass(
        "strict_agent_branch_namespaces",
        "Strict agent branch namespace posture is safe for the current integration mode.",
        branchNamespaceDetails,
      ),
    );
  }

  if (liveIntegrationActive && !verifiedAgentRunReceipts) {
    checks.push(
      fail(
        "verified_agent_run_receipts",
        "critical",
        "Live merge execution requires verified agent run receipts.",
        runReceiptDetails,
        ["enable_verified_agent_run_receipts"],
      ),
    );
  } else {
    checks.push(
      pass(
        "verified_agent_run_receipts",
        "Verified agent run receipt posture is safe for the current integration mode.",
        runReceiptDetails,
      ),
    );
  }

  if (
    liveIntegrationActive &&
    (!agentIdentityRegistry || knownAgentIdCount < 1)
  ) {
    checks.push(
      fail(
        "agent_identity_registry",
        "critical",
        "Live merge execution requires a strict allowed-agent identity registry.",
        identityRegistryDetails,
        ["enable_agent_identity_registry"],
      ),
    );
  } else {
    checks.push(
      pass(
        "agent_identity_registry",
        "Allowed-agent identity registry posture is safe for the current integration mode.",
        identityRegistryDetails,
      ),
    );
  }

  return checks;
}

function queueBlockerCheck({ counts, limits, mergeQueue }) {
  if (counts.blocked > limits.maxBlockedItems) {
    return fail(
      "queue_blockers_clear",
      "high",
      "Merge queue has blocked items.",
      {
        blocked: counts.blocked,
        maxBlockedItems: limits.maxBlockedItems,
        blockedItemIds: blockedItemIds(mergeQueue),
      },
      ["resolve_queue_blockers"],
    );
  }
  return pass(
    "queue_blockers_clear",
    "Merge queue blockers are within limits.",
    {
      blocked: counts.blocked,
      maxBlockedItems: limits.maxBlockedItems,
    },
  );
}

function queueLaneBusyCheck({ counts, limits, mergeQueue }) {
  if (counts.running > limits.maxRunningItems) {
    return fail(
      "queue_lanes_idle",
      "medium",
      "A merge queue lane is already running.",
      {
        running: counts.running,
        maxRunningItems: limits.maxRunningItems,
        runningItemIds: runningItemIds(mergeQueue),
      },
      ["wait_for_running_merge_lane"],
    );
  }
  return pass("queue_lanes_idle", "No merge queue lane is already running.", {
    running: counts.running,
    maxRunningItems: limits.maxRunningItems,
  });
}

function integrationPlanCheck({ counts, mergeQueue }) {
  const selectedPlan = mergeQueue?.selectedPlan ?? {};
  if (counts.planned > 0) {
    return pass("integration_plan_ready", "An integration plan is selected.", {
      planned: counts.planned,
      strategy: selectedPlan.strategy ?? null,
    });
  }
  if (counts.scheduled > 0) {
    return fail(
      "integration_plan_ready",
      "Queue has scheduled work but no selected integration plan.",
      {
        scheduled: counts.scheduled,
        selectedPlanReason: selectedPlan.reason ?? null,
        integrationEnabled: mergeQueue?.integration?.enabled === true,
      },
      ["enable_or_fix_integration_planning"],
    );
  }
  return pass(
    "integration_plan_ready",
    "No merge work is waiting for an integration plan.",
    {
      scheduled: counts.scheduled,
      planned: counts.planned,
    },
  );
}

function liveMergeCheck({ mergeQueue, requireLiveMerge }) {
  const integration = mergeQueue?.integration ?? {};
  const selectedPlan = mergeQueue?.selectedPlan ?? {};
  const dryRun = selectedPlan.dryRun ?? integration.dryRun;
  const enabled = selectedPlan.enabled ?? integration.enabled;

  if (requireLiveMerge && (enabled !== true || dryRun !== false)) {
    return fail(
      "live_merge_enabled",
      "high",
      "Live merge execution is required but not enabled.",
      {
        integrationEnabled: enabled === true,
        dryRun: dryRun !== false,
      },
      ["enable_live_merge_execution"],
    );
  }
  if (enabled === true && dryRun !== false) {
    return warn(
      "live_merge_enabled",
      "low",
      "Integration planning is in dry-run mode.",
      {
        integrationEnabled: true,
        dryRun: true,
      },
      ["confirm_live_merge_before_cutover"],
    );
  }
  if (enabled === true) {
    return pass("live_merge_enabled", "Live merge execution is enabled.", {
      integrationEnabled: true,
      dryRun: false,
    });
  }
  return warn(
    "live_merge_enabled",
    "medium",
    "Integration execution is not enabled.",
    {
      integrationEnabled: false,
      dryRun: dryRun !== false,
    },
    ["enable_integration_execution"],
  );
}

function repositoryProtectionChecks({
  repositoryProtection,
  requireRepositoryProtection,
}) {
  if (!repositoryProtection && !requireRepositoryProtection) return [];
  if (!repositoryProtection) {
    return [
      fail(
        "repository_protection_verified",
        "critical",
        "Repository protection audit is required but was not included.",
        {},
        ["run_repository_protection_audit"],
      ),
    ];
  }
  if (repositoryProtection.productionReady === true) {
    return [
      pass(
        "repository_protection_verified",
        "Repository protection is verified for live agent merges.",
        {
          status: repositoryProtection.status,
          labels: arrayValue(repositoryProtection.labels),
        },
      ),
    ];
  }

  const details = {
    status: repositoryProtection.status ?? null,
    productionReady: repositoryProtection.productionReady === true,
    labels: arrayValue(repositoryProtection.labels),
    failedChecks: arrayValue(repositoryProtection.checks)
      .filter((check) => check.status === "fail")
      .map((check) => check.name),
    warningChecks: arrayValue(repositoryProtection.checks)
      .filter((check) => check.status === "warn")
      .map((check) => check.name),
  };
  const actions = unique([
    ...arrayValue(repositoryProtection.requiredActions),
    "fix_repository_protection",
  ]);

  if (requireRepositoryProtection) {
    return [
      fail(
        "repository_protection_verified",
        "critical",
        `Repository protection is not production-ready: ${repositoryProtection.summary ?? repositoryProtection.status ?? "unknown"}`,
        details,
        actions,
      ),
    ];
  }

  return [
    warn(
      "repository_protection_verified",
      "medium",
      `Repository protection needs review: ${repositoryProtection.summary ?? repositoryProtection.status ?? "unknown"}`,
      details,
      actions,
    ),
  ];
}

function stackDependencyCheck({ counts, limits, mergeQueue }) {
  if (counts.stackBlocked > limits.maxStackBlockedItems) {
    const blockedItems = stackBlockedItems(mergeQueue);
    const stacks = stackSummaries(mergeQueue);
    return fail(
      "stack_dependency_order",
      "high",
      "Stacked PR children are waiting on parent PRs.",
      {
        stackCount: numberOrZero(
          mergeQueue?.dependencies?.stackCount ??
            mergeQueue?.diagnostics?.stacks?.stackCount,
        ),
        stackBlocked: counts.stackBlocked,
        maxStackBlockedItems: limits.maxStackBlockedItems,
        blockedItemIds: stackBlockedItemIds(mergeQueue),
        nextMergeItemIds: stackNextMergeItemIds(mergeQueue),
        blockedItems,
        stacks,
      },
      unique([
        ...blockedItems.flatMap((item) => arrayValue(item.requiredActions)),
        ...stacks.flatMap((stack) => arrayValue(stack.requiredActions)),
        "merge_stack_parents_first",
      ]),
    );
  }

  return pass(
    "stack_dependency_order",
    "Stacked PR dependencies are within release limits.",
    {
      stackBlocked: counts.stackBlocked,
      maxStackBlockedItems: limits.maxStackBlockedItems,
    },
  );
}

function humanDecisionCheck({ counts, limits }) {
  if (counts.openHumanDecisions > limits.maxOpenHumanDecisions) {
    return fail(
      "human_decisions_clear",
      "medium",
      "Open human decisions block release readiness.",
      {
        openHumanDecisions: counts.openHumanDecisions,
        maxOpenHumanDecisions: limits.maxOpenHumanDecisions,
      },
      ["resolve_human_decisions"],
    );
  }
  return pass(
    "human_decisions_clear",
    "No open human decisions exceed limits.",
    {
      openHumanDecisions: counts.openHumanDecisions,
      maxOpenHumanDecisions: limits.maxOpenHumanDecisions,
    },
  );
}

function agentTriageCheck({ counts, limits }) {
  const failures = [];
  if (counts.staleClaims > limits.maxStaleClaims) failures.push("stale_claims");
  if (counts.failedRuns > limits.maxFailedRuns) failures.push("failed_runs");
  if (counts.needsTriageAgents > limits.maxNeedsTriageAgents)
    failures.push("needs_triage_agents");
  if (counts.overloadedAgents > limits.maxOverloadedAgents)
    failures.push("overloaded_agents");

  if (failures.length > 0) {
    return fail(
      "agent_triage_clear",
      "high",
      "Agent stale or failed work must be cleared first.",
      {
        failures,
        staleClaims: counts.staleClaims,
        failedRuns: counts.failedRuns,
        needsTriageAgents: counts.needsTriageAgents,
        overloadedAgents: counts.overloadedAgents,
      },
      [
        "recover_failed_runs",
        "renew_or_release_stale_claims",
        "rebalance_overloaded_agents",
      ],
    );
  }
  return pass(
    "agent_triage_clear",
    "Agent stale and failed work is within limits.",
    {
      staleClaims: counts.staleClaims,
      failedRuns: counts.failedRuns,
      needsTriageAgents: counts.needsTriageAgents,
      overloadedAgents: counts.overloadedAgents,
    },
  );
}

function routingCapacityCheck({ counts, requireRoutableAgent }) {
  const needsRouting = counts.recommendations > 0 || counts.unassignedItems > 0;
  if (requireRoutableAgent && counts.routableAgents === 0) {
    return fail(
      "routing_capacity_available",
      "medium",
      "No routable agent capacity is available.",
      {
        routableAgents: counts.routableAgents,
        blockedAgents: counts.blockedAgents,
        recommendations: counts.recommendations,
        unassignedItems: counts.unassignedItems,
      },
      ["free_agent_capacity"],
    );
  }
  if (needsRouting && counts.routableAgents === 0) {
    return warn(
      "routing_capacity_available",
      "low",
      "Work is waiting but no agent has routable capacity.",
      {
        routableAgents: counts.routableAgents,
        blockedAgents: counts.blockedAgents,
        recommendations: counts.recommendations,
        unassignedItems: counts.unassignedItems,
      },
      ["watch_agent_capacity"],
    );
  }
  return pass(
    "routing_capacity_available",
    "Agent routing capacity is available or not required.",
    {
      routableAgents: counts.routableAgents,
      blockedAgents: counts.blockedAgents,
    },
  );
}

function decisionFor({ checks, counts, mergeQueue }) {
  const failures = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  const hasPlannedMergeWork = counts.planned > 0;
  const canOpenMergeWindow = failures.length === 0 && hasPlannedMergeWork;
  const canAutoMerge =
    canOpenMergeWindow &&
    mergeQueue?.integration?.enabled === true &&
    mergeQueue?.selectedPlan?.dryRun === false;
  const agentRoutingBlockers = new Set([
    "runtime_ready",
    "strict_work_reservations",
    "strict_work_items",
  ]);
  const canRouteNewAgentWork =
    failures.every((check) => !agentRoutingBlockers.has(check.name)) &&
    counts.routableAgents > 0;
  const status =
    failures.length > 0
      ? "blocked"
      : hasPlannedMergeWork
        ? warnings.length > 0
          ? "watch"
          : "ready"
        : "idle";

  return {
    status,
    canOpenMergeWindow,
    canAutoMerge,
    canRouteNewAgentWork,
    summary: summaryFor({ status, failures, warnings, counts }),
  };
}

function summaryFor({ status, failures, warnings, counts }) {
  if (failures.length > 0) return `Release blocked: ${failures[0].reason}`;
  if (status === "idle") return "No merge work is ready for a release window.";
  if (warnings.length > 0)
    return `Release can proceed with caution: ${warnings[0].reason}`;
  return `${counts.planned} planned queue item${counts.planned === 1 ? "" : "s"} ready for release.`;
}

function labelsFor({ decision, checks, mergeQueue }) {
  return unique([
    `release:${decision.status}`,
    decision.canOpenMergeWindow ? "merge-window:ready" : null,
    decision.canAutoMerge ? "merge-window:auto" : null,
    mergeQueue?.selectedPlan?.dryRun === true ? "merge-window:dry-run" : null,
    checks.some(
      (check) =>
        check.name === "repository_protection_verified" &&
        check.status === "fail",
    )
      ? "repo-protection:blocked"
      : null,
    checks.some(
      (check) =>
        check.name === "repository_protection_verified" &&
        check.status === "warn",
    )
      ? "repo-protection:watch"
      : null,
    checks.some(
      (check) =>
        check.name === "strict_work_reservations" && check.status === "fail",
    )
      ? "reservation:blocked"
      : null,
    checks.some(
      (check) => check.name === "strict_work_items" && check.status === "fail",
    )
      ? "work-item:blocked"
      : null,
    checks.some(
      (check) =>
        check.name === "strict_agent_branch_namespaces" &&
        check.status === "fail",
    )
      ? "branch-namespace:blocked"
      : null,
    checks.some(
      (check) =>
        check.name === "verified_agent_run_receipts" && check.status === "fail",
    )
      ? "run-receipt:blocked"
      : null,
    checks.some(
      (check) =>
        check.name === "agent_identity_registry" && check.status === "fail",
    )
      ? "identity-registry:blocked"
      : null,
    checks.some(
      (check) =>
        check.name === "stack_dependency_order" && check.status === "fail",
    )
      ? "stack:blocked"
      : null,
    checks.some(
      (check) =>
        check.name === "human_decisions_clear" && check.status === "fail",
    )
      ? "needs-human"
      : null,
    checks.some(
      (check) => check.name === "agent_triage_clear" && check.status === "fail",
    )
      ? "needs-triage"
      : null,
    checks.some(
      (check) =>
        check.name === "queue_blockers_clear" && check.status === "fail",
    )
      ? "queue:blocked"
      : null,
    checks.some(
      (check) => check.name === "queue_lanes_idle" && check.status === "fail",
    )
      ? "queue:busy"
      : null,
  ]);
}

function pass(name, reason, details = {}) {
  return {
    name,
    status: "pass",
    severity: "info",
    reason,
    details,
    requiredActions: [],
  };
}

function warn(name, severity, reason, details = {}, requiredActions = []) {
  return {
    name,
    status: "warn",
    severity,
    reason,
    details,
    requiredActions,
  };
}

function fail(name, severity, reason, details = {}, requiredActions = []) {
  return {
    name,
    status: "fail",
    severity,
    reason,
    details,
    requiredActions,
  };
}

function plannedItemIds(mergeQueue = {}) {
  return arrayValue(mergeQueue?.selectedPlan?.plans)
    .map(
      (plan) =>
        plan.id ??
        (plan.repo && plan.pullRequestId != null
          ? `${plan.repo}#${plan.pullRequestId}`
          : null),
    )
    .filter(Boolean);
}

function blockedItemIds(mergeQueue = {}) {
  return unique(
    arrayValue(mergeQueue?.lanes).flatMap((lane) =>
      arrayValue(lane.blockedItemIds),
    ),
  );
}

function stackBlockedItemIds(mergeQueue = {}) {
  return unique(
    stackBlockedItems(mergeQueue)
      .map((item) => item.id)
      .filter(Boolean),
  );
}

function stackNextMergeItemIds(mergeQueue = {}) {
  return unique(
    stackSummaries(mergeQueue)
      .map((stack) => stack.nextMergeItemId)
      .filter(Boolean),
  );
}

function stackBlockedItemCount(mergeQueue = {}) {
  return Math.max(
    stackBlockedItems(mergeQueue).length,
    numberOrZero(mergeQueue?.diagnostics?.stacks?.blockedItemCount),
    numberOrZero(mergeQueue?.dependencies?.blockedItemCount),
  );
}

function stackBlockedItems(mergeQueue = {}) {
  return arrayValue(mergeQueue?.diagnostics?.stacks?.blockedItems);
}

function stackSummaries(mergeQueue = {}) {
  return arrayValue(mergeQueue?.diagnostics?.stacks?.stacks);
}

function runningItemIds(mergeQueue = {}) {
  return unique(
    arrayValue(mergeQueue?.lanes).flatMap((lane) =>
      arrayValue(lane.runningItemIds),
    ),
  );
}

function repositoryProtectionSnapshot(repositoryProtection) {
  if (!repositoryProtection) return null;
  return {
    status: repositoryProtection.status ?? null,
    productionReady: repositoryProtection.productionReady === true,
    labels: arrayValue(repositoryProtection.labels),
    requiredActions: arrayValue(repositoryProtection.requiredActions),
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

const RUNNING_QUEUE_STATES = new Set(["running", "building_integration"]);
const RUNNING_RUN_STATUSES = new Set(["running", "queued", "in_progress"]);
const WAITING_RUN_STATUSES = new Set([
  "waiting_event",
  "waiting_approval",
  "waiting_input",
  "waiting",
]);
const FAILED_RUN_STATUSES = new Set([
  "failed",
  "failure",
  "error",
  "cancelled",
  "canceled",
  "timed_out",
]);
const SUCCEEDED_RUN_STATUSES = new Set([
  "succeeded",
  "success",
  "completed",
  "passed",
]);

const CLAIMABLE_ACTIONS = new Set([
  "release_or_renew_stale_claim",
  "route_failed_checks",
  "rebase_or_update_branch",
  "coordinate_overlapping_prs",
  "resolve_policy_blocker",
  "wait_for_checks",
  "enter_merge_queue",
  "inspect",
]);

const MAX_CONCURRENT_CLAIMS = 2;

export function buildAgentCapacity({
  insights,
  claims = [],
  runs = [],
  now = new Date().toISOString(),
  repo,
  ownerAgentId,
  targetBranch,
  maxSuggestions = 20,
  performance,
} = {}) {
  const filters = normalizeFilters({
    repo: repo ?? insights?.filters?.repo,
    ownerAgentId: ownerAgentId ?? insights?.filters?.ownerAgentId,
    targetBranch: targetBranch ?? insights?.filters?.targetBranch,
  });
  const agents = new Map();
  const scopedClaims = claims.filter((claim) =>
    matchesRepo(claim, filters.repo),
  );
  const scopedRuns = runs.filter((run) => matchesRepo(run, filters.repo));
  const items = (insights?.items ?? []).filter((item) =>
    matchesItemFilters(item, filters),
  );

  for (const item of items) {
    const agentId = item.ownerAgentId ?? item.suggestedOwnerAgentId;
    if (!agentId) continue;
    const agent = ensureAgent(agents, agentId);
    addItemToAgent(agent, item);
  }

  for (const claim of scopedClaims) {
    if (
      !claim.ownerAgentId ||
      (filters.ownerAgentId && claim.ownerAgentId !== filters.ownerAgentId)
    )
      continue;
    const agent = ensureAgent(agents, claim.ownerAgentId);
    addClaimToAgent(agent, claim, now);
  }

  for (const run of scopedRuns) {
    if (run.ownerKind && run.ownerKind !== "agent") continue;
    if (
      !run.ownerId ||
      (filters.ownerAgentId && run.ownerId !== filters.ownerAgentId)
    )
      continue;
    const agent = ensureAgent(agents, run.ownerId);
    addRunToAgent(agent, run);
  }

  const performanceByAgent = new Map(
    (performance?.agents ?? []).map((agent) => [agent.agentId, agent]),
  );
  const agentSummaries = [...agents.values()]
    .map((agent) => finalizeAgent(agent, performanceByAgent.get(agent.agentId)))
    .sort(compareAgents);
  const unassignedItems = items
    .filter((item) => !item.ownerAgentId)
    .filter((item) => !RUNNING_QUEUE_STATES.has(item.queueState))
    .filter(
      (item) =>
        item.human?.openApprovals === 0 && item.human?.openRequests === 0,
    )
    .filter((item) => (item.claims?.active ?? []).length === 0)
    .map(itemSummary)
    .sort(compareUnassignedItems);
  const assignmentSuggestions = buildAssignmentSuggestions({
    items: unassignedItems,
    agents: agentSummaries,
    maxSuggestions,
  });

  return {
    computedAt: now,
    filters,
    counts: {
      agents: agentSummaries.length,
      idle: agentSummaries.filter((agent) => agent.health === "idle").length,
      available: agentSummaries.filter((agent) => agent.health === "available")
        .length,
      busy: agentSummaries.filter((agent) => agent.health === "busy").length,
      overloaded: agentSummaries.filter(
        (agent) => agent.health === "overloaded",
      ).length,
      needsTriage: agentSummaries.filter(
        (agent) => agent.health === "needs-triage",
      ).length,
      canTakeNewWork: agentSummaries.filter((agent) => agent.canTakeNewWork)
        .length,
      queueItems: agentSummaries.reduce(
        (count, agent) => count + agent.counts.queueItems,
        0,
      ),
      activeClaims: agentSummaries.reduce(
        (count, agent) => count + agent.counts.activeClaims,
        0,
      ),
      staleClaims: agentSummaries.reduce(
        (count, agent) => count + agent.counts.staleClaims,
        0,
      ),
      runningRuns: agentSummaries.reduce(
        (count, agent) => count + agent.counts.runningRuns,
        0,
      ),
      failedRuns: agentSummaries.reduce(
        (count, agent) => count + agent.counts.failedRuns,
        0,
      ),
      unassignedItems: unassignedItems.length,
      assignmentSuggestions: assignmentSuggestions.length,
    },
    agents: agentSummaries,
    unassignedItems,
    assignmentSuggestions,
  };
}

export function buildClaimFromAssignmentSuggestion(
  suggestion,
  { ownerAgentId, now } = {},
) {
  if (!suggestion?.resource?.kind || !suggestion?.resource?.id) {
    throw new TypeError("Agent assignment suggestion requires a resource");
  }
  if (!ownerAgentId) {
    throw new TypeError("Agent assignment claim requires ownerAgentId");
  }

  return {
    repo: suggestion.repo,
    resourceKind: suggestion.resource.kind,
    resourceId: suggestion.resource.id,
    ownerAgentId: String(ownerAgentId),
    taskId: null,
    paths: suggestion.resource.paths,
    metadata: {
      source: "agent-capacity-assignment",
      suggestionId: suggestion.id,
      action: suggestion.action,
      itemId: suggestion.itemId,
      pullRequestId: suggestion.pullRequestId,
      targetBranch: suggestion.targetBranch,
      reason: suggestion.reason,
      selectedAt: now ?? null,
    },
  };
}

function ensureAgent(agents, agentId) {
  const id = String(agentId);
  if (!agents.has(id)) {
    agents.set(id, {
      agentId: id,
      counts: {
        queueItems: 0,
        ready: 0,
        blocked: 0,
        runningQueueItems: 0,
        needsHuman: 0,
        failedChecks: 0,
        staleBranches: 0,
        duplicateRiskItems: 0,
        recommendations: 0,
        activeClaims: 0,
        staleClaims: 0,
        runningRuns: 0,
        waitingRuns: 0,
        failedRuns: 0,
        succeededRuns: 0,
      },
      expertise: {
        paths: new Set(),
        packages: new Set(),
      },
      work: [],
      claims: {
        active: [],
        stale: [],
      },
      runs: {
        active: [],
        waiting: [],
        failed: [],
      },
      actionCounts: new Map(),
      recommendationSamples: [],
    });
  }
  return agents.get(id);
}

function addItemToAgent(agent, item) {
  agent.counts.queueItems += 1;
  if (
    item.decision?.allowed === true &&
    !RUNNING_QUEUE_STATES.has(item.queueState)
  )
    agent.counts.ready += 1;
  if (item.decision?.allowed === false) agent.counts.blocked += 1;
  if (RUNNING_QUEUE_STATES.has(item.queueState))
    agent.counts.runningQueueItems += 1;
  if (item.human?.openApprovals > 0 || item.human?.openRequests > 0)
    agent.counts.needsHuman += 1;
  agent.counts.failedChecks += item.checks?.failed?.length ?? 0;
  if (item.staleBranch?.stale === true) agent.counts.staleBranches += 1;
  if (item.duplicateRisk?.overlapping === true)
    agent.counts.duplicateRiskItems += 1;
  agent.counts.recommendations += item.recommendations?.length ?? 0;

  for (const path of item.impact?.paths ?? []) agent.expertise.paths.add(path);
  for (const packageName of item.impact?.packages ?? [])
    agent.expertise.packages.add(packageName);
  for (const action of item.nextActions ?? []) {
    agent.actionCounts.set(action, (agent.actionCounts.get(action) ?? 0) + 1);
  }
  agent.recommendationSamples.push(
    ...(item.recommendations ?? []).map((recommendation) => ({
      id: recommendation.id,
      action: recommendation.action,
      severity: recommendation.severity,
      itemId: recommendation.itemId,
      title: recommendation.title,
    })),
  );
  agent.work.push(itemSummary(item));
}

function addClaimToAgent(agent, claim, now) {
  const summary = claimSummary(claim, now);
  if (summary.status === "stale") {
    agent.counts.staleClaims += 1;
    agent.claims.stale.push(summary);
  } else if (summary.status === "active") {
    agent.counts.activeClaims += 1;
    agent.claims.active.push(summary);
  }

  for (const path of claim.paths ?? []) agent.expertise.paths.add(String(path));
  if (claim.resourceKind === "path" && claim.resourceId)
    agent.expertise.paths.add(String(claim.resourceId));
  if (claim.resourceKind === "package" && claim.resourceId)
    agent.expertise.packages.add(String(claim.resourceId));
}

function addRunToAgent(agent, run) {
  const summary = runSummary(run);
  const status = normalizeStatus(run.status);
  if (RUNNING_RUN_STATUSES.has(status)) {
    agent.counts.runningRuns += 1;
    agent.runs.active.push(summary);
  } else if (WAITING_RUN_STATUSES.has(status)) {
    agent.counts.waitingRuns += 1;
    agent.runs.waiting.push(summary);
  } else if (FAILED_RUN_STATUSES.has(status)) {
    agent.counts.failedRuns += 1;
    agent.runs.failed.push(summary);
  } else if (SUCCEEDED_RUN_STATUSES.has(status)) {
    agent.counts.succeededRuns += 1;
  }
}

function finalizeAgent(agent, performance) {
  const workloadScore = workloadScoreFor(agent.counts);
  const availableSlots = Math.max(
    0,
    MAX_CONCURRENT_CLAIMS -
      agent.counts.activeClaims -
      agent.counts.runningRuns,
  );
  const health = healthFor({ counts: agent.counts, workloadScore });
  const performanceSummary = summarizePerformance(performance);
  return {
    agentId: agent.agentId,
    health,
    canTakeNewWork:
      availableSlots > 0 &&
      (health === "idle" || health === "available") &&
      canRouteByPerformance(performanceSummary),
    workloadScore,
    availableSlots,
    counts: agent.counts,
    performance: performanceSummary,
    expertise: {
      paths: [...agent.expertise.paths].sort().slice(0, 12),
      packages: [...agent.expertise.packages].sort().slice(0, 12),
    },
    topActions: [...agent.actionCounts.entries()]
      .map(([action, count]) => ({ action, count }))
      .sort(
        (left, right) =>
          right.count - left.count || left.action.localeCompare(right.action),
      )
      .slice(0, 6),
    currentWork: agent.work.sort(compareWork).slice(0, 8),
    claims: {
      active: agent.claims.active.sort(compareClaims).slice(0, 8),
      stale: agent.claims.stale.sort(compareClaims).slice(0, 8),
    },
    runs: {
      active: agent.runs.active.sort(compareRuns).slice(0, 8),
      waiting: agent.runs.waiting.sort(compareRuns).slice(0, 8),
      failed: agent.runs.failed.sort(compareRuns).slice(0, 8),
    },
    recommendations: agent.recommendationSamples
      .sort(compareRecommendationSamples)
      .slice(0, 8),
  };
}

function buildAssignmentSuggestions({ items, agents, maxSuggestions }) {
  const assignableAgents = agents.filter((agent) => agent.canTakeNewWork);
  if (assignableAgents.length === 0) return [];

  return items
    .map((item) => {
      const rankedAgents = assignableAgents
        .map((agent) => scoreAgentForItem(agent, item))
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.agentId.localeCompare(right.agentId),
        );
      const best = rankedAgents[0];
      if (!best) return null;
      const action = firstClaimableAction(item.nextActions);
      return {
        id: `assign:${item.id}:${best.agentId}`,
        agentId: best.agentId,
        itemId: item.id,
        repo: item.repo,
        pullRequestId: item.pullRequestId,
        targetBranch: item.targetBranch,
        priority: item.priority,
        action,
        score: best.score,
        reason: assignmentReason(best),
        resource: assignmentResource(item),
        itemSummary: item.summary,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        right.score - left.score ||
        left.id.localeCompare(right.id),
    )
    .slice(0, positiveInteger(maxSuggestions) ?? 20);
}

function scoreAgentForItem(agent, item) {
  const packageMatches = arrayValue(item.impact?.packages).filter(
    (packageName) => agent.expertise.packages.includes(packageName),
  );
  const pathMatches = arrayValue(item.impact?.paths).filter((path) =>
    agent.expertise.paths.some(
      (agentPath) =>
        path === agentPath ||
        path.startsWith(`${agentPath}/`) ||
        agentPath.startsWith(`${path}/`),
    ),
  );
  const score =
    20 +
    agent.availableSlots * 8 -
    agent.workloadScore * 2 +
    packageMatches.length * 10 +
    pathMatches.length * 6 +
    (agent.health === "idle" ? 5 : 0) +
    performanceScore(agent.performance) +
    numberOrZero(item.priority);
  return {
    agentId: agent.agentId,
    score,
    packageMatches,
    pathMatches,
    availableSlots: agent.availableSlots,
    workloadScore: agent.workloadScore,
    performanceHealth: agent.performance?.health ?? null,
  };
}

function assignmentReason(match) {
  const reasons = [];
  if (match.packageMatches.length > 0)
    reasons.push(
      `package match: ${match.packageMatches.slice(0, 2).join(", ")}`,
    );
  if (match.pathMatches.length > 0)
    reasons.push(`path match: ${match.pathMatches.slice(0, 2).join(", ")}`);
  reasons.push(
    `${match.availableSlots} open slot${match.availableSlots === 1 ? "" : "s"}`,
  );
  reasons.push(`workload score ${match.workloadScore}`);
  if (match.performanceHealth)
    reasons.push(`performance ${match.performanceHealth}`);
  return reasons.join("; ");
}

function assignmentResource(item) {
  if (item.pullRequestId != null) {
    return {
      kind: "pull_request",
      id: String(item.pullRequestId),
      paths: arrayValue(item.impact?.paths),
    };
  }
  return {
    kind: "queue_item",
    id: item.id,
    paths: arrayValue(item.impact?.paths),
  };
}

function summarizePerformance(performance) {
  if (!performance) return null;
  return {
    health: performance.health ?? null,
    loadScore: numberOrZero(performance.loadScore),
    riskScore: numberOrZero(performance.riskScore),
    activityScore: numberOrZero(performance.activityScore),
    lastActivityAt: performance.lastActivityAt ?? null,
    counts: {
      activeClaims: numberOrZero(performance.counts?.activeClaims),
      staleClaims: numberOrZero(performance.counts?.staleClaims),
      activeRuns: numberOrZero(performance.counts?.activeRuns),
      waitingRuns: numberOrZero(performance.counts?.waitingRuns),
      succeededRuns: numberOrZero(performance.counts?.succeededRuns),
      failedRuns: numberOrZero(performance.counts?.failedRuns),
      transferredIn: numberOrZero(performance.counts?.transferredIn),
      transferredOut: numberOrZero(performance.counts?.transferredOut),
      handoffs: numberOrZero(performance.counts?.handoffs),
    },
    rates: {
      successRate: rateOrNull(performance.rates?.successRate),
      failureRate: rateOrNull(performance.rates?.failureRate),
      staleClaimRatio: rateOrNull(performance.rates?.staleClaimRatio),
      handoffRatio: rateOrNull(performance.rates?.handoffRatio),
    },
    riskSignals: arrayValue(performance.riskSignals),
  };
}

function canRouteByPerformance(performance) {
  if (!performance) return true;
  return (
    performance.health !== "needs-triage" && performance.health !== "overloaded"
  );
}

function performanceScore(performance) {
  if (!performance) return 0;
  const successRate = performance.rates.successRate;
  const failureRate = performance.rates.failureRate;
  const staleClaimRatio = performance.rates.staleClaimRatio;
  const handoffRatio = performance.rates.handoffRatio;
  return (
    healthScore(performance.health) +
    (successRate == null ? 0 : successRate * 8) -
    (failureRate == null ? 0 : failureRate * 12) -
    (staleClaimRatio == null ? 0 : staleClaimRatio * 8) -
    (handoffRatio == null ? 0 : Math.min(8, handoffRatio * 3)) -
    performance.riskScore * 1.5
  );
}

function healthScore(health) {
  return (
    {
      healthy: 4,
      idle: 2,
      watch: -4,
      overloaded: -16,
      "needs-triage": -20,
    }[health] ?? 0
  );
}

function itemSummary(item) {
  return {
    id: item.id,
    repo: item.repo ?? null,
    pullRequestId: item.pullRequestId ?? null,
    targetBranch: item.targetBranch ?? null,
    sourceBranch: item.sourceBranch ?? null,
    queueState: item.queueState ?? null,
    createdAt: item.createdAt ?? null,
    updatedAt: item.updatedAt ?? null,
    priority: numberOrZero(item.priority),
    summary: item.summary ?? null,
    impact: {
      paths: arrayValue(item.impact?.paths),
      packages: arrayValue(item.impact?.packages),
    },
    nextActions: arrayValue(item.nextActions),
    risk: item.risk ?? null,
  };
}

function claimSummary(claim, now) {
  return {
    id: claim.id ?? null,
    repo: claim.repo ?? null,
    resourceKind: claim.resourceKind ?? null,
    resourceId: claim.resourceId ?? null,
    status:
      claim.status === "active" && isExpired(claim.expiresAt, now)
        ? "stale"
        : (claim.status ?? "unknown"),
    expiresAt: claim.expiresAt ?? null,
    paths: arrayValue(claim.paths),
  };
}

function runSummary(run) {
  return {
    id: run.id ?? null,
    queueItemId: run.queueItemId ?? null,
    repo: run.repo ?? null,
    pullRequestId: run.pullRequestId ?? null,
    status: run.status ?? null,
    updatedAt: run.updatedAt ?? run.createdAt ?? null,
  };
}

function healthFor({ counts, workloadScore }) {
  if (workloadScore === 0) return "idle";
  if (
    counts.failedChecks > 0 ||
    counts.staleClaims > 0 ||
    counts.staleBranches > 0 ||
    counts.failedRuns > 0 ||
    counts.needsHuman > 0
  ) {
    return "needs-triage";
  }
  if (
    counts.activeClaims >= MAX_CONCURRENT_CLAIMS + 1 ||
    counts.runningQueueItems + counts.runningRuns >= 3 ||
    workloadScore >= 10
  ) {
    return "overloaded";
  }
  if (
    counts.activeClaims > 0 ||
    counts.runningQueueItems > 0 ||
    counts.runningRuns > 0 ||
    counts.queueItems > 1
  )
    return "busy";
  return "available";
}

function workloadScoreFor(counts) {
  return (
    counts.queueItems +
    counts.ready +
    counts.blocked * 2 +
    counts.runningQueueItems * 3 +
    counts.needsHuman * 2 +
    counts.failedChecks * 2 +
    counts.staleBranches +
    counts.duplicateRiskItems +
    counts.activeClaims * 2 +
    counts.staleClaims * 2 +
    counts.runningRuns * 2 +
    counts.waitingRuns +
    counts.failedRuns * 2
  );
}

function firstClaimableAction(actions = []) {
  return actions.find((action) => CLAIMABLE_ACTIONS.has(action)) ?? "inspect";
}

function compareAgents(left, right) {
  return (
    healthRank(left.health) - healthRank(right.health) ||
    right.workloadScore - left.workloadScore ||
    left.agentId.localeCompare(right.agentId)
  );
}

function compareWork(left, right) {
  return (
    right.priority - left.priority ||
    String(left.id).localeCompare(String(right.id))
  );
}

function compareUnassignedItems(left, right) {
  return (
    right.priority - left.priority ||
    String(left.id).localeCompare(String(right.id))
  );
}

function compareClaims(left, right) {
  return (
    String(left.expiresAt ?? "").localeCompare(String(right.expiresAt ?? "")) ||
    String(left.id ?? "").localeCompare(String(right.id ?? ""))
  );
}

function compareRuns(left, right) {
  return (
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) ||
    String(left.id ?? "").localeCompare(String(right.id ?? ""))
  );
}

function compareRecommendationSamples(left, right) {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function healthRank(health) {
  return (
    {
      "needs-triage": 0,
      overloaded: 1,
      busy: 2,
      available: 3,
      idle: 4,
    }[health] ?? 9
  );
}

function severityRank(severity) {
  return (
    {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      info: 4,
    }[severity] ?? 5
  );
}

function matchesItemFilters(item, filters) {
  if (filters.repo && item.repo !== filters.repo) return false;
  if (
    filters.ownerAgentId &&
    item.ownerAgentId !== filters.ownerAgentId &&
    item.suggestedOwnerAgentId !== filters.ownerAgentId
  )
    return false;
  if (filters.targetBranch && item.targetBranch !== filters.targetBranch)
    return false;
  return true;
}

function matchesRepo(record, repo) {
  if (!repo) return true;
  if (record.repo) return record.repo === repo;
  if (record.queueItemId)
    return String(record.queueItemId).startsWith(`${repo}#`);
  return false;
}

function normalizeFilters({ repo, ownerAgentId, targetBranch }) {
  return {
    repo: repo ? String(repo) : null,
    ownerAgentId: ownerAgentId ? String(ownerAgentId) : null,
    targetBranch: targetBranch ? String(targetBranch) : null,
  };
}

function isExpired(expiresAt, now) {
  return (
    Boolean(expiresAt) &&
    new Date(expiresAt).getTime() <= new Date(now).getTime()
  );
}

function normalizeStatus(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function arrayValue(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function rateOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
